const REPOSITORY = 'ssdkllpd/japanese-football-watch';
const PREFIX = 'automation/workflow-dispatch/v1/';
const WORKFLOWS = Object.freeze([
  { file: 'api-football-automation.yml', confirmation: 'RUN API-FOOTBALL AUTOMATION', due: date => date.getUTCMinutes() % 15 === 0 },
  { file: 'api-football-schedule-sync.yml', confirmation: 'RUN SCHEDULE SYNC', due: date => date.getUTCMinutes() === 37 && date.getUTCHours() % 4 === 1 },
]);

export function dueSlots(scheduledTime) {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) throw new Error('Invalid scheduled time');
  const minute = Math.floor(scheduledTime / 60000) * 60000;
  return WORKFLOWS.flatMap(workflow => {
    // Catch a late tick without replaying a backlog of obsolete fifteen-minute runs.
    for (let age = 0; age < 15; age++) {
      const date = new Date(minute - age * 60000);
      if (workflow.due(date)) return [{ ...workflow, slot: date.toISOString() }];
    }
    return [];
  });
}

export async function dispatchScheduled(event, env, request = fetch) {
  if (env.DISPATCH_ENABLED !== 'true') return { enabled: false, results: [] };
  if (!env.GITHUB_DISPATCH_TOKEN || !env.DISPATCH_STATE) throw new Error('Dispatcher credentials or storage missing');
  const headers = {
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
    'x-github-api-version': '2026-03-10',
    'user-agent': 'jfw-workflow-dispatcher',
  };
  const results = [];
  for (const workflow of dueSlots(event.scheduledTime)) {
    const key = `${PREFIX}${workflow.slot.slice(0, 10)}/${workflow.file}/${workflow.slot}.json`;
    if (await env.DISPATCH_STATE.head(key)) {
      results.push({ workflow: workflow.file, slot: workflow.slot, status: 'already_attempted' });
      continue;
    }
    const base = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${workflow.file}`;
    // Defer while this workflow is queued or executing. Retry on the next minute,
    // before claiming the slot, to avoid building an unbounded Actions queue.
    const runs = await request(`${base}/runs?branch=main&per_page=100`, {
      headers, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!runs.ok) throw new Error(`GitHub run inspection HTTP ${runs.status}`);
    const payload = await runs.json();
    if (!Array.isArray(payload.workflow_runs)) throw new Error('Invalid GitHub run response');
    if (payload.workflow_runs.some(run => run.status !== 'completed')) {
      results.push({ workflow: workflow.file, slot: workflow.slot, status: 'deferred_busy' });
      continue;
    }
    const record = { workflow: workflow.file, slot: workflow.slot, status: 'attempting', attemptedAt: new Date().toISOString() };
    // R2 conditional creation is the shared claim across isolates and repeated cron
    // deliveries. Persist before POST: ambiguous network failures are never retried
    // blindly because GitHub workflow_dispatch has no idempotency key.
    const claim = await env.DISPATCH_STATE.put(key, JSON.stringify(record), {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
    });
    if (!claim) {
      results.push({ workflow: workflow.file, slot: workflow.slot, status: 'already_attempted' });
      continue;
    }
    try {
      const response = await request(`${base}/dispatches`, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ ref: 'main', inputs: {
          mode: 'execute', confirmation: workflow.confirmation,
          trigger_source: 'cloudflare', trigger_slot: workflow.slot,
        } }),
      });
      record.status = [200, 204].includes(response.status) ? 'accepted' : 'rejected';
      record.httpStatus = response.status;
      if (response.status === 200) {
        const run = await response.json().catch(() => null);
        if (Number.isSafeInteger(run?.workflow_run_id) && run.workflow_run_id > 0) {
          record.workflowRunId = run.workflow_run_id;
        }
      }
    } catch {
      record.status = 'uncertain';
    }
    await env.DISPATCH_STATE.put(key, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
    console.log(JSON.stringify(record));
    results.push(record);
    if (record.status !== 'accepted') throw new Error(`Workflow dispatch ${record.status}: ${workflow.file}`);
  }
  return { enabled: true, results };
}

export default {
  async scheduled(event, env) { return dispatchScheduled(event, env); },
  fetch() { return new Response('Not found', { status: 404 }); },
};
