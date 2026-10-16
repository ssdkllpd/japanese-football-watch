'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function storage() {
  const objects = new Map();
  return {
    objects,
    async head(key) { return objects.has(key) ? { key } : null; },
    async put(key, value, options) {
      if (options?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      objects.set(key, value);
      return { key };
    },
  };
}
const event = { scheduledTime: Date.parse('2026-10-16T01:00:00Z') };
const AUTO_KEY = 'automation/workflow-dispatch/v1/test-1/2026-10-16/api-football-automation.yml/2026-10-16T01:00:00.000Z.json';
const environment = () => {
  const state = storage();
  // The schedule slot preceding these automation-only cases was already claimed.
  state.objects.set('automation/workflow-dispatch/v1/test-1/2026-10-15/api-football-schedule-sync.yml/2026-10-15T21:37:00.000Z.json', '{}');
  return { DISPATCH_ENABLED: 'true', DISPATCH_EPOCH: 'test-1', WORKFLOW_DISPATCH_TOKEN: 'test-only-secret', DISPATCH_STATE: state };
};

test('dispatcher preserves the 96 automation and six schedule slots per UTC day', async () => {
  const { dueSlots } = await import('../dispatcher-worker/index.mjs');
  const counts = {};
  for (let minute = 0; minute < 1440; minute++) {
    const time = Date.parse('2026-10-16T00:00:00Z') + minute * 60000;
    for (const slot of dueSlots(time).filter(value => Date.parse(value.slot) === time)) {
      counts[slot.file] = (counts[slot.file] || 0) + 1;
    }
  }
  assert.deepEqual(counts, { 'api-football-automation.yml': 96, 'api-football-schedule-sync.yml': 6 });
  assert.equal(dueSlots(event.scheduledTime + 14 * 60000)[0].slot, '2026-10-16T01:00:00.000Z');
  assert.equal(dueSlots(event.scheduledTime + 15 * 60000)[0].slot, '2026-10-16T01:15:00.000Z');
  const scheduleSlot = time => dueSlots(Date.parse(time)).find(slot => slot.file === 'api-football-schedule-sync.yml').slot;
  assert.equal(scheduleSlot('2026-10-16T05:36:00Z'), '2026-10-16T01:37:00.000Z');
  assert.equal(scheduleSlot('2026-10-16T05:37:00Z'), '2026-10-16T05:37:00.000Z');
});

test('disabled dispatcher does not touch credentials, storage, or network', async () => {
  const { dispatchScheduled } = await import('../dispatcher-worker/index.mjs');
  const env = { DISPATCH_ENABLED: 'false', get WORKFLOW_DISPATCH_TOKEN() { throw new Error('must not read'); } };
  const result = await dispatchScheduled(event, env, () => { throw new Error('must not fetch'); });
  assert.deepEqual(result, { enabled: false, results: [] });
});

test('concurrent and repeated cron deliveries dispatch exactly once per shared slot', async () => {
  const { dispatchScheduled } = await import('../dispatcher-worker/index.mjs');
  const env = environment();
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    assert.ok(url.startsWith('https://api.github.com/repos/ssdkllpd/japanese-football-watch/actions/workflows/'));
    assert.equal(options.headers.authorization, 'Bearer test-only-secret');
    assert.equal(options.redirect, 'manual');
    if (options.method !== 'POST') return Response.json({ workflow_runs: [] });
    assert.deepEqual(JSON.parse(options.body), { ref: 'main', inputs: {
      mode: 'execute', confirmation: 'RUN API-FOOTBALL AUTOMATION',
      trigger_source: 'cloudflare', trigger_slot: '2026-10-16T01:00:00.000Z', trigger_epoch: 'test-1',
    } });
    return new Response(null, { status: 204 });
  };
  await Promise.all(Array.from({ length: 5 }, () => dispatchScheduled(event, env, request)));
  await dispatchScheduled({ scheduledTime: event.scheduledTime + 60000 }, env, request);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(env.DISPATCH_STATE.objects.size, 2);
  assert.doesNotMatch([...env.DISPATCH_STATE.objects.values()].join(''), /test-only-secret/);
  assert.equal(JSON.parse(env.DISPATCH_STATE.objects.get(AUTO_KEY)).status, 'accepted');
});

test('busy Actions workflow defers without claiming and retries on the next minute', async () => {
  const { dispatchScheduled } = await import('../dispatcher-worker/index.mjs');
  const env = environment();
  let busy = true, posts = 0;
  const request = async (_, options) => {
    if (options.method === 'POST') { posts++; return new Response(null, { status: 204 }); }
    return Response.json({ workflow_runs: busy ? [{ status: 'queued' }] : [] });
  };
  const result = await dispatchScheduled(event, env, request);
  assert.equal(result.results[0].status, 'deferred_busy');
  assert.equal(env.DISPATCH_STATE.objects.size, 1);
  busy = false;
  await dispatchScheduled({ scheduledTime: event.scheduledTime + 60000 }, env, request);
  assert.equal(posts, 1);
});

test('a new deployment verifies its current slots without reusing earlier deployment claims', async () => {
  const { dispatchScheduled } = await import('../dispatcher-worker/index.mjs');
  const env = { ...environment(), DISPATCH_STATE: storage() };
  let posts = 0;
  const request = async (_, options) => {
    if (options.method === 'POST') { posts++; return new Response(null, { status: 204 }); }
    return Response.json({ workflow_runs: [] });
  };
  await dispatchScheduled(event, env, request);
  await dispatchScheduled(event, env, request);
  assert.equal(posts, 2);
  await dispatchScheduled(event, { ...env, DISPATCH_EPOCH: 'test-2' }, request);
  assert.equal(posts, 4);
});

test('current GitHub dispatch response records its accepted workflow run id', async () => {
  const { dispatchScheduled } = await import('../dispatcher-worker/index.mjs');
  const env = environment();
  const result = await dispatchScheduled(event, env, async (_, options) => {
    assert.equal(options.headers['x-github-api-version'], '2026-03-10');
    return options.method === 'POST'
      ? Response.json({ workflow_run_id: 12345 })
      : Response.json({ workflow_runs: [] });
  });
  assert.equal(result.results[0].status, 'accepted');
  assert.equal(result.results[0].workflowRunId, 12345);
});

test('ambiguous POST failure is recorded and never blindly retried', async () => {
  const { dispatchScheduled } = await import('../dispatcher-worker/index.mjs');
  const env = environment();
  let posts = 0;
  const request = async (_, options) => {
    if (options.method === 'POST') { posts++; throw new Error('ambiguous delivery'); }
    return Response.json({ workflow_runs: [] });
  };
  await assert.rejects(dispatchScheduled(event, env, request), /uncertain/);
  await dispatchScheduled(event, env, request);
  assert.equal(posts, 1);
  assert.equal(JSON.parse(env.DISPATCH_STATE.objects.get(AUTO_KEY)).status, 'uncertain');
});

test('failed run inspection cannot claim a slot or send a dispatch', async () => {
  const { dispatchScheduled } = await import('../dispatcher-worker/index.mjs');
  const env = environment();
  await assert.rejects(dispatchScheduled(event, env, async () => new Response(null, { status: 403 })), /inspection HTTP 403/);
  assert.equal(env.DISPATCH_STATE.objects.size, 1);
});

test('redirect responses fail closed without following or retrying a dispatch', async () => {
  const { dispatchScheduled } = await import('../dispatcher-worker/index.mjs');
  for (const stage of ['inspection', 'dispatch']) {
    const env = environment();
    let calls = 0;
    const request = async (_, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      if (stage === 'dispatch' && options.method !== 'POST') return Response.json({ workflow_runs: [] });
      return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/' } });
    };
    await assert.rejects(dispatchScheduled(event, env, request), stage === 'inspection' ? /inspection HTTP 302/ : /rejected/);
    assert.equal(calls, stage === 'inspection' ? 1 : 2);
    if (stage === 'inspection') assert.equal(env.DISPATCH_STATE.objects.has(AUTO_KEY), false);
    else {
      assert.equal(JSON.parse(env.DISPATCH_STATE.objects.get(AUTO_KEY)).httpStatus, 302);
      await dispatchScheduled(event, env, request);
      assert.equal(calls, 2);
    }
  }
});

test('schedule dispatch uses the existing workflow confirmation and records rejected POSTs', async () => {
  const { dispatchScheduled } = await import('../dispatcher-worker/index.mjs');
  const env = environment();
  let posts = 0;
  const request = async (url, options) => {
    if (options.method !== 'POST') return Response.json({ workflow_runs: [] });
    posts++;
    assert.match(url, /api-football-schedule-sync.yml\/dispatches$/);
    assert.equal(JSON.parse(options.body).inputs.confirmation, 'RUN SCHEDULE SYNC');
    return new Response(null, { status: 403 });
  };
  const tick = { scheduledTime: Date.parse('2026-10-16T01:37:00Z') };
  // Automation's 01:30 slot has already been accepted before the schedule slot.
  env.DISPATCH_STATE.objects.set('automation/workflow-dispatch/v1/test-1/2026-10-16/api-football-automation.yml/2026-10-16T01:30:00.000Z.json', '{}');
  await assert.rejects(dispatchScheduled(tick, env, request), /rejected/);
  await dispatchScheduled(tick, env, request);
  assert.equal(posts, 1);
  const records = [...env.DISPATCH_STATE.objects.values()].map(value => JSON.parse(value));
  assert.ok(records.some(record => record.status === 'rejected' && record.httpStatus === 403));
});

test('renderer refuses enabling while either legacy cron is still configured', async t => {
  const { renderDispatcher } = await import('../scripts/v2/render-workflow-dispatcher.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-dispatcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  const policy = path.join(root, 'config/workflow-dispatcher.json');
  const output = path.join(root, '.tmp/wrangler.toml');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 'jfw-workflow-dispatcher/1', triggerSource: 'github' }));
  assert.deepEqual(renderDispatcher(root, output), { enabled: false });
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 'jfw-workflow-dispatcher/1', triggerSource: 'cloudflare' }));
  for (const file of ['api-football-automation.yml', 'api-football-schedule-sync.yml']) {
    fs.writeFileSync(path.join(root, '.github/workflows', file), 'on:\n  schedule:\n');
  }
  assert.throws(() => renderDispatcher(root, output), /Remove legacy schedule/);
  fs.writeFileSync(path.join(root, '.github/workflows/api-football-automation.yml'), 'on:\n  workflow_dispatch:\n');
  assert.throws(() => renderDispatcher(root, output), /api-football-schedule-sync/);
  fs.writeFileSync(path.join(root, '.github/workflows/api-football-schedule-sync.yml'), 'on:\n  workflow_dispatch:\n');
  assert.deepEqual(renderDispatcher(root, output), { enabled: true });
  assert.match(fs.readFileSync(output, 'utf8'), /workers_dev = false/);
});
