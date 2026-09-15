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
  assert.deepEqual(report.results[0].retryHistory.map(item => ({
    attempt: item.attempt, status: item.status, kind: item.responseBodyKind,
    retryAfter: item.retryAfter || null,
  })), [
    { attempt: 1, status: 503, kind: 'empty', retryAfter: null },
    { attempt: 2, status: 429, kind: 'empty', retryAfter: '2' },
  ]);
});

test('major-league migration does not retry a deterministic data rejection', async () => {
  const { executeRequests } = await import('../scripts/d1/migrate-major-league-snapshot.mjs');
  let calls = 0;
  const report = await executeRequests(prepared(), {
    url: 'https://admin.example',
    token: 'secret-token',
    async fetchImpl() {
      calls += 1;
      return new Response(JSON.stringify({
        error: 'Admin ingest rejected', detail: 'invalid fixture data',
      }), {
        status: 422, headers: { 'content-type': 'application/json' },
      });
    },
    async sleep() { throw new Error('sleep must not be called'); },
  });

  assert.equal(calls, 1);
  assert.equal(report.completed, false);
  assert.deepEqual(report.results[0], {
    operation: 'fixture_migration_publish', identity: 'af:fixture:1570363',
    passed: false, status: 422, attempts: 1,
    responseBodyBytes: 65,
    responseBodySha256: '9a92bb42557787173b1805a8a34e118f931856324b295be7707b5d30f74302c1',
    responseBodyKind: 'json', responseContentType: 'application/json',
    serviceError: 'Admin ingest rejected', detail: 'invalid fixture data',
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
        return new Response('temporary upstream failure', {
          status: 503, headers: { 'content-type': 'text/plain', 'cf-ray': 'run8-example' },
        });
      },
      async sleep(milliseconds) { sleeps.push(milliseconds); },
    });

    assert.equal(calls, 6);
    assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000]);
    assert.equal(report.completed, false);
    assert.equal(report.results[0].attempts, 6);
    assert.equal(report.results[0].status, failure === 'http' ? 503 : null);
    assert.equal(report.results[0].error, failure === 'network' ? 'TypeError' : undefined);
    assert.equal(report.results[0].retryHistory.length, 5);
    if (failure === 'http') {
      assert.equal(report.results[0].responseBodyKind, 'non_json');
      assert.equal(report.results[0].responseBodyBytes, 26);
      assert.equal(report.results[0].cfRay, 'run8-example');
    }
  }
});

test('major-league migration honours Retry-After HTTP dates', async () => {
  const { executeRequests } = await import('../scripts/d1/migrate-major-league-snapshot.mjs');
  const now = Date.parse('2026-09-15T12:00:00.000Z');
  const responses = [
    new Response('', { status: 503, headers: { 'retry-after': 'Tue, 15 Sep 2026 12:00:15 GMT' } }),
    success(),
  ];
  const sleeps = [];
  const report = await executeRequests(prepared(), {
    url: 'https://admin.example', token: 'secret-token', now: () => now,
    async fetchImpl() { return responses.shift(); },
    async sleep(milliseconds) { sleeps.push(milliseconds); },
  });
  assert.equal(report.completed, true);
  assert.deepEqual(sleeps, [15_000]);
});

test('major-league migration bounds failure reports and stops before its execution budget', async () => {
  const { executeRequests } = await import('../scripts/d1/migrate-major-league-snapshot.mjs');
  const largeReport = { schemaVersion: 'example/1', operation: 'fixture_migration_publish',
    payload: 'x'.repeat(100_000) };
  let report = await executeRequests(prepared(), {
    url: 'https://admin.example', token: 'secret-token',
    async fetchImpl() {
      return new Response(JSON.stringify({ ok: false, report: largeReport }), {
        status: 422, headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(Object.hasOwn(report.results[0], 'report'), false);
  assert.equal(report.results[0].failureReportBytes > 100_000, true);
  assert.match(report.results[0].failureReportSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.results[0].failureReportSchemaVersion, 'example/1');

  let calls = 0;
  report = await executeRequests(prepared(), {
    url: 'https://admin.example', token: 'secret-token', maxExecutionMilliseconds: 10_000,
    now: () => Date.parse('2026-09-15T12:00:00.000Z'),
    async fetchImpl() {
      calls += 1;
      return new Response('', { status: 503, headers: { 'retry-after': '30' } });
    },
    async sleep() { throw new Error('budget guard must stop before sleeping'); },
  });
  assert.equal(calls, 1);
  assert.equal(report.completed, false);
  assert.equal(report.results[0].error, 'ExecutionBudgetExceeded');
  assert.equal(report.results[0].status, 503);
  assert.equal(report.results[0].attempts, 1);
});
