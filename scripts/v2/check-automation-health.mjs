import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'ssdkllpd/japanese-football-watch';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const WORKFLOWS = [
  { file: 'api-football-automation.yml', label: 'API-Football Automation', maxAgeMinutes: 30 },
  { file: 'api-football-schedule-sync.yml', label: 'API-Football Schedule Sync', maxAgeMinutes: 270 },
];
const OPEN = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
const MINUTE = 60000;
// Do not echo upstream response bodies or transport exception text: either may
// include credentials. Only messages authored by this module may enter reports.
function safeReadError(error) {
  const message = error instanceof Error ? error.message : '';
  return /^(Health read HTTP [0-9]{3}|Invalid (successful run inventory|or truncated job inventory|synchronization completion time|open run inventory|open run creation time|token scope response|dispatcher settings|dispatcher schedule)|Open run inventory truncated)$/.test(message)
    ? message : 'Remote read failed (network or invalid response)';
}

async function json(request, url, token) {
  const response = await request(url, { headers: { authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10',
    'user-agent': 'jfw-automation-watchdog' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Health read HTTP ${response.status}`);
  return response.json();
}

export async function checkWorkflowHealth({ env = process.env, request = fetch, now = Date.now() } = {}) {
  if (!env.GH_TOKEN) throw new Error('Independent GitHub Actions read token is required');
  const problems = [], workflows = [];
  for (const workflow of WORKFLOWS) {
    const base = `${API}/actions/workflows/${workflow.file}`;
    try {
      const definition = await json(request, base, env.GH_TOKEN);
      if (definition.state !== 'active') problems.push(`${workflow.file}: workflow is not active`);
      const success = await json(request, `${base}/runs?branch=main&status=success&per_page=100`, env.GH_TOKEN);
      if (!Array.isArray(success.workflow_runs)) throw new Error('Invalid successful run inventory');
      let finishedAt = null, runId = null;
      for (const run of success.workflow_runs) {
        if (run.event !== 'workflow_dispatch' || run.head_branch !== 'main'
          || !run.display_title?.startsWith(`${workflow.label} [Cloudflare `)) continue;
        const jobs = await json(request, `${API}/actions/runs/${run.id}/jobs?per_page=100`, env.GH_TOKEN);
        if (!Array.isArray(jobs.jobs) || jobs.jobs.length >= 100) throw new Error('Invalid or truncated job inventory');
        const job = jobs.jobs.find(value => value.name === 'synchronize' && value.status === 'completed' && value.conclusion === 'success');
        if (!job) continue; // successful preview or skipped jobs are not heartbeats
        const time = Date.parse(job.completed_at);
        if (!Number.isFinite(time) || time > now + MINUTE) throw new Error('Invalid synchronization completion time');
        if (finishedAt === null || time > Date.parse(finishedAt)) { finishedAt = new Date(time).toISOString(); runId = run.id; }
        // Runs are ordered by creation, not completion. Inspect all recent
        // completions that could still satisfy this workflow's freshness bound.
        if (Date.parse(run.created_at) < now - workflow.maxAgeMinutes * MINUTE) break;
      }
      const ageMinutes = finishedAt === null ? null : (now - Date.parse(finishedAt)) / MINUTE;
      if (ageMinutes === null || ageMinutes >= workflow.maxAgeMinutes) {
        problems.push(`${workflow.file}: no successful synchronization within ${workflow.maxAgeMinutes} minutes`);
      }
      const stuck = new Map();
      for (const status of OPEN) {
        for (let page = 1; page <= 10; page++) {
          const open = await json(request, `${base}/runs?branch=main&status=${status}&per_page=100&page=${page}`, env.GH_TOKEN);
          if (!Array.isArray(open.workflow_runs)) throw new Error('Invalid open run inventory');
          for (const run of open.workflow_runs) {
            const created = Date.parse(run.created_at);
            if (!Number.isFinite(created) || created > now + MINUTE) throw new Error('Invalid open run creation time');
            if (run.status !== 'completed' && now - created >= 90 * MINUTE) stuck.set(run.id, { runId: run.id, status: run.status, createdAt: new Date(created).toISOString() });
          }
          if (open.workflow_runs.length < 100) break;
          if (page === 10) throw new Error('Open run inventory truncated');
        }
      }
      for (const run of stuck.values()) problems.push(`${workflow.file}: run ${run.runId} unfinished for at least 90 minutes (${run.status})`);
      workflows.push({ workflow: workflow.file, lastSuccessfulRunId: runId, lastSuccessfulAt: finishedAt,
        maxAgeMinutes: workflow.maxAgeMinutes, ageMinutes, stuckRuns: [...stuck.values()] });
    } catch (error) { problems.push(`${workflow.file}: ${safeReadError(error)}`); }
  }
  if (env.GITHUB_EVENT_PATH && env.GITHUB_EVENT_NAME === 'workflow_run') {
    const run = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).workflow_run;
    if (run?.head_branch === 'main' && run.event !== 'pull_request' && run.status === 'completed'
      && ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(run.conclusion)) {
      problems.push(`Observed failed acquisition/deployment run ${run.id}: ${run.conclusion}`);
    }
  }
  return { passed: problems.length === 0, checkedAt: new Date(now).toISOString(), workflows, problems };
}

export async function checkDispatchPlatform({ env = process.env, request = fetch, now = Date.now() } = {}) {
  const problems = [], warnings = [];
  let expiresAt = null;
  if (!env.WORKFLOW_DISPATCH_TOKEN) problems.push('Dispatch token is missing');
  else {
    try {
      const response = await request(`${API}/actions/workflows?per_page=100`, {
        headers: { authorization: `Bearer ${env.WORKFLOW_DISPATCH_TOKEN}`, accept: 'application/vnd.github+json',
          'x-github-api-version': '2026-03-10' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) problems.push(`Dispatch token authentication HTTP ${response.status}`);
      else {
        const payload = await response.json();
        if (!Array.isArray(payload.workflows)) throw new Error('Invalid token scope response');
        for (const workflow of WORKFLOWS) if (!payload.workflows.some(value => value.path === `.github/workflows/${workflow.file}` && value.state === 'active')) {
          problems.push(`Dispatch token cannot see active ${workflow.file}`);
        }
        const expiration = response.headers.get('github-authentication-token-expiration') || env.WORKFLOW_DISPATCH_TOKEN_EXPIRES_AT;
        if (expiration) {
          const time = Date.parse(expiration);
          if (!Number.isFinite(time)) problems.push('Dispatch token expiry metadata is invalid');
          else {
            expiresAt = new Date(time).toISOString();
            if (time - now <= 7 * 86400000) problems.push('Dispatch token expires within seven days or is already expired');
          }
        } else warnings.push('GitHub did not expose token expiry; set repository variable WORKFLOW_DISPATCH_TOKEN_EXPIRES_AT to the expiry date');
      }
    } catch (error) { problems.push(`Dispatch credential check: ${safeReadError(error)}`); }
  }
  if (!env.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) problems.push('Cloudflare inspection credentials missing');
  else {
    try {
      const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/jfw-football-workflow-dispatcher`;
      const settings = await json(request, `${base}/settings`, env.CLOUDFLARE_API_TOKEN);
      if (settings.success !== true || !Array.isArray(settings.result?.bindings)) throw new Error('Invalid dispatcher settings');
      if (!settings.result.bindings.some(binding => binding.name === 'DISPATCH_ENABLED' && binding.text === 'true')) problems.push('Cloudflare dispatch is disabled');
      if (!settings.result.bindings.some(binding => binding.name === 'WORKFLOW_DISPATCH_TOKEN' && binding.type === 'secret_text')) problems.push('Cloudflare dispatch credential binding is missing');
      const schedules = await json(request, `${base}/schedules`, env.CLOUDFLARE_API_TOKEN);
      if (schedules.success !== true || !Array.isArray(schedules.result?.schedules)) throw new Error('Invalid dispatcher schedule');
      if (!schedules.result.schedules.some(schedule => schedule.cron === '* * * * *')) problems.push('Cloudflare minute schedule is missing');
    } catch (error) { problems.push(`Cloudflare inspection: ${safeReadError(error)}`); }
  }
  return { passed: problems.length === 0, checkedAt: new Date(now).toISOString(), dispatchTokenExpiresAt: expiresAt, problems, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['workflows', 'platform'].includes(mode)) throw new Error('Use workflows or platform');
  const report = await (mode === 'workflows' ? checkWorkflowHealth() : checkDispatchPlatform());
  const directory = '.tmp/automation-health';
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(`${directory}/${mode}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  const summary = [`## Automation watchdog: ${mode}`, `Result: ${report.passed ? 'healthy' : 'attention required'}`,
    ...(report.problems || []).map(value => `- ${value}`), ...(report.warnings || []).map(value => `- Warning: ${value}`),
    report.dispatchTokenExpiresAt ? `Dispatch token expires: ${report.dispatchTokenExpiresAt}` : '',
    ...(report.workflows || []).map(value => `- ${value.workflow}: last successful synchronization ${value.lastSuccessfulAt || 'not found'} (run ${value.lastSuccessfulRunId || 'none'})`)].filter(Boolean).join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  for (const warning of report.warnings || []) console.log(`::warning::${warning}`);
  for (const problem of report.problems) console.error(`::error::${problem}`);
  if (!report.passed) process.exitCode = 1;
}
