'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function prepared() {
  return { requests: [{
    schemaVersion: 'jfw-d1-admin-ingest/1',
    operation: 'fixture_migration_publish',
    fixtureId: 'af:fixture:1570363',
  }] };
}

function success() {
  return new Response(JSON.stringify({ ok: true, report: { imported: true } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

test('major-league migration retries a transient HTTP failure and preserves one logical result', async () => {
  const { executeRequests } = await import('../scripts/d1/migrate-major-league-snapshot.mjs');
  const statuses = [503, 429, 200];
  const sleeps = [];
  const report = await executeRequests(prepared(), {
    url: 'https://admin.example',
    token: 'secret-token',
    async fetchImpl() {
      const status = statuses.shift();
      if (status === 200) return success();
      return new Response('', {
        status,
        headers: status === 429 ? { 'retry-after': '2' } : {},
      });
    },
    async sleep(milliseconds) { sleeps.push(milliseconds); },
  });

  assert.equal(report.completed, true);
  assert.deepEqual(report.results.map(item => ({
    identity: item.identity, passed: item.passed, status: item.status, attempts: item.attempts,
  })), [{ identity: 'af:fixture:1570363', passed: true, status: 200, attempts: 3 }]);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('major-league migration does not retry a deterministic data rejection', async () => {
  const { executeRequests } = await import('../scripts/d1/migrate-major-league-snapshot.mjs');
  let calls = 0;
  const report = await executeRequests(prepared(), {
    url: 'https://admin.example',
    token: 'secret-token',
    async fetchImpl() {
      calls += 1;
      return new Response(JSON.stringify({ detail: 'invalid fixture data' }), { status: 422 });
    },
    async sleep() { throw new Error('sleep must not be called'); },
  });

  assert.equal(calls, 1);
  assert.equal(report.completed, false);
  assert.deepEqual(report.results[0], {
    operation: 'fixture_migration_publish', identity: 'af:fixture:1570363',
    passed: false, status: 422, attempts: 1, detail: 'invalid fixture data',
  });
});

test('major-league migration bounds retries for persistent 503 and transient network errors', async () => {
  const { executeRequests } = await import('../scripts/d1/migrate-major-league-snapshot.mjs');
  for (const failure of ['http', 'network']) {
    let calls = 0;
    const sleeps = [];
    const report = await executeRequests(prepared(), {
      url: 'https://admin.example',
      token: 'secret-token',
      async fetchImpl() {
        calls += 1;
        if (failure === 'network') throw new TypeError('temporary network failure');
        return new Response('', { status: 503 });
      },
      async sleep(milliseconds) { sleeps.push(milliseconds); },
    });

    assert.equal(calls, 4);
    assert.deepEqual(sleeps, [1000, 2000, 4000]);
    assert.equal(report.completed, false);
    assert.equal(report.results[0].attempts, 4);
    assert.equal(report.results[0].status, failure === 'http' ? 503 : null);
    assert.equal(report.results[0].error, failure === 'network' ? 'TypeError' : undefined);
  }
});
