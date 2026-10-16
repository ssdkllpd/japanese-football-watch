'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const now = Date.parse('2026-10-16T06:40:00Z');
const env = { GH_TOKEN: 'independent-test-token' };
const labels = { 'api-football-automation.yml': 'API-Football Automation', 'api-football-schedule-sync.yml': 'API-Football Schedule Sync' };
const iso = minutes => new Date(now - minutes * 60000).toISOString();
function github(options = {}) {
  return async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer independent-test-token');
    assert.equal(init.redirect, 'error');
    assert.equal(url.startsWith('https://api.github.com/repos/ssdkllpd/japanese-football-watch/actions/'), true);
    if (options.httpFailure) return new Response(null, { status: 503 });
    if (/\/jobs\?/.test(url)) {
      const auto = url.includes('/runs/11/');
      const minutes = auto ? options.autoAge ?? 5 : options.scheduleAge ?? 65;
      return Response.json({ jobs: [{ name: 'synchronize', status: 'completed',
        conclusion: options.skipped && auto ? 'skipped' : 'success', completed_at: iso(minutes) }] });
    }
    const file = url.match(/workflows\/([^/?]+)/)[1];
    const auto = file === 'api-football-automation.yml';
    if (!url.includes('/runs?')) return Response.json({ state: options.disabled && auto ? 'disabled_manually' : 'active' });
    const status = new URL(url).searchParams.get('status');
    if (status === 'success') return Response.json({ workflow_runs: [{ id: auto ? 11 : 22,
      event: 'workflow_dispatch', head_branch: 'main', created_at: iso(auto ? options.autoAge ?? 6 : 66),
      display_title: options.preview && auto ? 'API-Football Automation' : `${labels[file]} [Cloudflare slot / epoch]` }] });
    return Response.json({ workflow_runs: options.stuckStatus === status && auto ? [{ id: 99, status, created_at: iso(options.stuckAge ?? 91) }] : [] });
  };
}

test('independent token verifies successful synchronize jobs, including healthy no-op acquisitions', async () => {
  const { checkWorkflowHealth } = await import('../scripts/v2/check-automation-health.mjs');
  const result = await checkWorkflowHealth({ env, now, request: github() });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.workflows[0].lastSuccessfulRunId, 11);
  assert.equal(result.workflows[1].maxAgeMinutes, 270);
});

for (const [name, options, message] of [
  ['30 minute automation gap', { autoAge: 30 }, /within 30 minutes/],
  ['four hour plus grace schedule gap', { scheduleAge: 270 }, /within 270 minutes/],
  ['queued run beyond 90 minutes', { stuckStatus: 'queued' }, /90 minutes \(queued\)/],
  ['running run beyond 90 minutes', { stuckStatus: 'in_progress' }, /90 minutes \(in_progress\)/],
  ['waiting run beyond 90 minutes', { stuckStatus: 'waiting' }, /90 minutes \(waiting\)/],
  ['pending run beyond 90 minutes', { stuckStatus: 'pending' }, /90 minutes \(pending\)/],
  ['manual preview cannot mask stopped cron', { preview: true }, /within 30 minutes/],
  ['skipped synchronize job cannot mask stopped cron', { skipped: true }, /within 30 minutes/],
  ['disabled workflow', { disabled: true }, /not active/],
  ['unavailable GitHub does not look healthy', { httpFailure: true }, /HTTP 503/],
]) test(`watchdog rejects ${name}`, async () => {
  const { checkWorkflowHealth } = await import('../scripts/v2/check-automation-health.mjs');
  const result = await checkWorkflowHealth({ env, now, request: github(options) });
  assert.equal(result.passed, false);
  assert.match(result.problems.join('\n'), message);
});

test('queued work under 90 minutes does not alarm while the last completion is fresh', async () => {
  const { checkWorkflowHealth } = await import('../scripts/v2/check-automation-health.mjs');
  assert.equal((await checkWorkflowHealth({ env, now, request: github({ stuckStatus: 'queued', stuckAge: 89 }) })).passed, true);
});

test('deployment failure alarms immediately even when acquisition heartbeats are fresh', async t => {
  const { checkWorkflowHealth } = await import('../scripts/v2/check-automation-health.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-watchdog-event-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const event = path.join(dir, 'event.json');
  fs.writeFileSync(event, JSON.stringify({ workflow_run: { id: 123, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure' } }));
  const result = await checkWorkflowHealth({ env: { ...env, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event }, now, request: github() });
  assert.equal(result.passed, false);
  assert.match(result.problems.join(), /failed acquisition\/deployment run 123/);
});

const platformEnv = { WORKFLOW_DISPATCH_TOKEN: 'dispatch-test-secret', CLOUDFLARE_API_TOKEN: 'cf-test-secret', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
function platform(options = {}) {
  return async (url, init) => {
    if (url.startsWith('https://api.github.com/')) {
      assert.equal(init.headers.authorization, 'Bearer dispatch-test-secret');
      if (options.expired) return new Response(null, { status: 401 });
      return Response.json({ workflows: Object.keys(labels).map(file => ({ path: `.github/workflows/${file}`, state: 'active' })) },
        { headers: options.noExpiry ? {} : { 'GitHub-Authentication-Token-Expiration': new Date(now + (options.expiring ? 6 : 90) * 86400000).toISOString() } });
    }
    assert.equal(init.headers.authorization, 'Bearer cf-test-secret');
    assert.equal(init.method, undefined, 'platform inspections must not mutate remote resources');
    if (url.endsWith('/settings')) return Response.json({ success: true, result: { bindings: [
      { name: 'DISPATCH_ENABLED', text: options.disabled ? 'false' : 'true' },
      ...(options.missingSecret ? [] : [{ name: 'WORKFLOW_DISPATCH_TOKEN', type: 'secret_text' }]),
    ] } });
    assert.equal(url.endsWith('/schedules'), true);
    return Response.json({ success: true, result: { schedules: options.noCron ? [] : [{ cron: '* * * * *' }] } });
  };
}

test('platform reports expiry date without exposing either credential', async () => {
  const { checkDispatchPlatform } = await import('../scripts/v2/check-automation-health.mjs');
  const result = await checkDispatchPlatform({ env: platformEnv, now, request: platform() });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.dispatchTokenExpiresAt, new Date(now + 90 * 86400000).toISOString());
  for (const secret of ['dispatch-test-secret', 'cf-test-secret']) assert.equal(JSON.stringify(result).includes(secret), false);
});
for (const [name, options, message] of [
  ['expired token', { expired: true }, /authentication HTTP 401/],
  ['token expiring in seven days', { expiring: true }, /seven days/],
  ['disabled dispatcher', { disabled: true }, /dispatch is disabled/],
  ['missing worker credential', { missingSecret: true }, /binding is missing/],
  ['removed cron', { noCron: true }, /minute schedule is missing/],
]) test(`platform detects ${name}`, async () => {
  const { checkDispatchPlatform } = await import('../scripts/v2/check-automation-health.mjs');
  const result = await checkDispatchPlatform({ env: platformEnv, now, request: platform(options) });
  assert.equal(result.passed, false);
  assert.match(result.problems.join(), message);
});

test('missing expiry metadata is explicit and a configured expiry can supply it', async () => {
  const { checkDispatchPlatform } = await import('../scripts/v2/check-automation-health.mjs');
  const result = await checkDispatchPlatform({ env: platformEnv, now, request: platform({ noExpiry: true }) });
  assert.equal(result.dispatchTokenExpiresAt, null);
  assert.match(result.warnings.join(), /did not expose token expiry/);
  const configured = await checkDispatchPlatform({ env: { ...platformEnv, WORKFLOW_DISPATCH_TOKEN_EXPIRES_AT: new Date(now + 6 * 86400000).toISOString() }, now, request: platform({ noExpiry: true }) });
  assert.equal(configured.passed, false);
});

test('watchdog stays independent of the dispatch token and alerts through failed Actions runs', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/automation-watchdog.yml'), 'utf8');
  const acquisition = workflow.split('  acquisition-health:')[1].split('  dispatch-platform:')[0];
  assert.match(acquisition, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(acquisition, /environment:|WORKFLOW_DISPATCH_TOKEN|CLOUDFLARE/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /actions: read/);
  assert.doesNotMatch(workflow, /continue-on-error|actions: write|issues: write/);
});

 test('upstream exception text cannot leak secrets into watchdog reports', async () => {
  const { checkWorkflowHealth, checkDispatchPlatform } = await import('../scripts/v2/check-automation-health.mjs');
  const request = async () => { throw new Error('dispatch-test-secret cf-test-secret independent-test-token'); };
  const health = await checkWorkflowHealth({ env, now, request });
  const platform = await checkDispatchPlatform({ env: platformEnv, now, request });
  assert.equal(health.passed, false);
  assert.equal(platform.passed, false);
  assert.doesNotMatch(JSON.stringify({ health, platform }), /dispatch-test-secret|cf-test-secret|independent-test-token/);
 });
