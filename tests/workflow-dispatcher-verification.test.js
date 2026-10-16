'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const NOW = Date.parse('2026-10-16T03:01:00Z');
const env = { CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'test-cf-token', WORKFLOW_DISPATCH_TOKEN: 'test-gh-token', GITHUB_SHA: 'reviewed-commit' };
const cases = [
  { file: 'api-football-automation.yml', name: 'API-Football Automation', slot: '2026-10-16T03:00:00.000Z', id: 1 },
  { file: 'api-football-schedule-sync.yml', name: 'API-Football Schedule Sync', slot: '2026-10-16T01:37:00.000Z', id: 2 },
];
function requestFor(mode = 'success') {
  return async (url, options) => {
    assert.equal(options.method, undefined, 'Verification is read only');
    assert.equal(options.redirect, 'error');
    if (url.startsWith('https://api.cloudflare.com/')) {
      assert.equal(options.headers.authorization, 'Bearer test-cf-token');
      const row = cases.find(row => url.includes(`/${row.file}/`));
      assert.ok(row, url);
      return Response.json({ workflow: row.file, slot: row.slot, workflowRunId: row.id,
        attemptedAt: new Date(mode === 'stale' ? NOW - 600000 : NOW).toISOString(),
        status: mode === 'rejected' ? 'rejected' : 'accepted' });
    }
    assert.ok(url.startsWith('https://api.github.com/repos/ssdkllpd/japanese-football-watch/actions/runs/'));
    assert.equal(options.headers.authorization, 'Bearer test-gh-token');
    const row = cases.find(row => url.includes(`/runs/${row.id}`));
    assert.ok(row, url);
    if (url.includes('/jobs?')) return Response.json({ jobs: [{ name: 'synchronize', conclusion: mode === 'skipped' ? 'skipped' : 'success' }] });
    return Response.json({ id: row.id, event: 'workflow_dispatch', head_branch: 'main',
      head_sha: mode === 'wrong-commit' ? 'other-commit' : env.GITHUB_SHA,
      display_title: `${row.name} [Cloudflare ${row.slot}]`, status: 'completed',
      conclusion: mode === 'failed' ? 'failure' : 'success', html_url: `https://github.com/ssdkllpd/japanese-football-watch/actions/runs/${row.id}` });
  };
}

test('cutover evidence binds both stored cron records to successful synchronization jobs on the exact commit', async () => {
  const { verifyDispatcher } = await import('../scripts/v2/verify-workflow-dispatcher.mjs');
  const report = await verifyDispatcher({ env, request: requestFor(), now: () => NOW });
  assert.equal(report.passed, true);
  assert.deepEqual(report.workflows.map(row => row.runId), [1, 2]);
  assert.doesNotMatch(JSON.stringify(report), /test-cf-token|test-gh-token/);
});

for (const [mode, message] of [['rejected', /dispatch rejected/], ['wrong-commit', /identity mismatch/], ['failed', /workflow failed/], ['skipped', /did not execute/]]) {
  test(`cutover verification rejects ${mode} evidence`, async () => {
    const { verifyDispatcher } = await import('../scripts/v2/verify-workflow-dispatcher.mjs');
    await assert.rejects(verifyDispatcher({ env, request: requestFor(mode), now: () => NOW }), message);
  });
}

test('stale pre-deployment dispatch records cannot prove the cutover', async () => {
  const { verifyDispatcher } = await import('../scripts/v2/verify-workflow-dispatcher.mjs');
  let time = NOW;
  await assert.rejects(verifyDispatcher({ env, request: requestFor('stale'), now: () => time,
    timeoutMs: 1000, sleep: async () => { time += 1000; } }), /timed out: accepted 0/);
});
