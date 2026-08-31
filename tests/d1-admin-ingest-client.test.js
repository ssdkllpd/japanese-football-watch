'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function fixtureFiles(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-admin-client-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify({ productSeasonId: 'jfw:season:2026-27' }));
  fs.writeFileSync(path.join(directory, 'corrections.json'), JSON.stringify({
    schemaVersion: 'd1-fixture-correction-definitions/1', fixtureId: 'af:fixture:9001', definitions: [],
  }));
  return directory;
}

function plan() {
  return {
    schemaVersion: 'jfw-d1-admin-ingest-plan/1',
    standings: [{ competitionId: 'af:competition:39', seasonId: 'af:season:39:2026' }],
    fixtures: [{
      fixtureId: 'af:fixture:9001', competitionId: 'af:competition:39',
      seasonId: 'af:season:39:2026', catalogPath: 'catalog.json',
      correctionsPath: 'corrections.json',
    }],
  };
}

test('admin ingest client sends externally declared requests and keeps its token out of the report', async t => {
  const { executeAdminIngestPlan } = await import('../scripts/d1/request-admin-ingest.mjs');
  const directory = fixtureFiles(t);
  const calls = [];
  const report = await executeAdminIngestPlan(plan(), {
    url: 'https://admin.example/original/path?unsafe=1', token: 'secret-token', planDirectory: directory,
    async fetchImpl(url, options) {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, report: { operation: calls.at(-1).body.operation } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(report.passed, true);
  assert.deepEqual(report.summary, { total: 2, passed: 2, failed: 0 });
  assert.deepEqual(calls.map(item => item.url), [
    'https://admin.example/admin/v1/ingest', 'https://admin.example/admin/v1/ingest',
  ]);
  assert.equal(calls.every(item => item.options.redirect === 'error'), true);
  assert.equal(calls[1].body.catalog.productSeasonId, 'jfw:season:2026-27');
  assert.equal(JSON.stringify(report).includes('secret-token'), false);
});

test('admin ingest client reports every independent failure without declaring production readiness', async t => {
  const { executeAdminIngestPlan } = await import('../scripts/d1/request-admin-ingest.mjs');
  const directory = fixtureFiles(t);
  let call = 0;
  const report = await executeAdminIngestPlan(plan(), {
    url: 'https://admin.example', token: 'secret-token', planDirectory: directory,
    async fetchImpl() {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ error: 'rejected' }), { status: 422 });
      throw new TypeError('simulated network failure');
    },
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.summary, { total: 2, passed: 0, failed: 2 });
  assert.deepEqual(report.results.map(item => item.status), [422, null]);
  assert.equal(report.productionReady, false);
});

test('admin ingest client sends a hash-scoped fixed snapshot bootstrap without embedding the artifact', async t => {
  const { executeAdminIngestPlan } = await import('../scripts/d1/request-admin-ingest.mjs');
  const directory = fixtureFiles(t);
  const bootstrap = plan();
  bootstrap.standings = [];
  bootstrap.fixtures = [];
  bootstrap.fixedSnapshot = {
    artifactSha256: 'b'.repeat(64),
    productSeasonId: 'jfw:season:2026-27',
  };
  let sent;
  const report = await executeAdminIngestPlan(bootstrap, {
    url: 'https://admin.example', token: 'secret-token', planDirectory: directory,
    async fetchImpl(url, options) {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok: true, report: { status: 'imported' } }), { status: 200 });
    },
  });
  assert.equal(report.passed, true);
  assert.deepEqual(sent, {
    schemaVersion: 'jfw-d1-admin-ingest/1',
    operation: 'fixed_snapshot_publish',
    artifactSha256: 'b'.repeat(64),
    productSeasonId: 'jfw:season:2026-27',
  });
  assert.equal(Object.hasOwn(sent, 'snapshot'), false);
  assert.match(report.results[0].identity, /^jfw:season:2026-27\/b{64}$/);
});

test('admin ingest client rejects duplicate scopes, unsafe paths, and non-HTTPS remote endpoints', async t => {
  const { executeAdminIngestPlan } = await import('../scripts/d1/request-admin-ingest.mjs');
  const directory = fixtureFiles(t);
  const duplicate = plan();
  duplicate.standings.push({ ...duplicate.standings[0] });
  await assert.rejects(() => executeAdminIngestPlan(duplicate, {
    url: 'https://admin.example', token: 'token', planDirectory: directory,
  }), /duplicate scopes/);

  const escaped = plan();
  escaped.fixtures[0].catalogPath = '../catalog.json';
  await assert.rejects(() => executeAdminIngestPlan(escaped, {
    url: 'https://admin.example', token: 'token', planDirectory: directory,
  }), /escapes the plan directory/);

  await assert.rejects(() => executeAdminIngestPlan(plan(), {
    url: 'http://admin.example', token: 'token', planDirectory: directory,
  }), /must use HTTPS/);

  await assert.rejects(() => executeAdminIngestPlan(plan(), {
    url: 'https://user:password@admin.example', token: 'token', planDirectory: directory,
  }), /must not contain credentials/);
});
