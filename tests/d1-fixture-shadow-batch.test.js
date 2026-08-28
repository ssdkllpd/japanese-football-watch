'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  PLAN_SCHEMA_VERSION,
  resolveArtifactPath,
  runFixtureShadowPlan,
  validateFixtureShadowPlan,
} = require('../scripts/d1/fixture-shadow-batch');

function bundle(fixtureId, home = 1) {
  return {
    contractVersion: '2.1.0',
    detailAvailability: 'available',
    fixture: { id: fixtureId, kickoffUtc: '2026-08-21T20:00:00.000Z', score: { goals: { home, away: 0 } } },
    events: [],
    lineups: [],
    playerStats: [],
    teamStats: [],
    sectionStates: {},
    overrides: {},
    fieldIssues: {},
  };
}

test('batch report aggregates equal, different and unreadable fixtures without stopping early', () => {
  const files = new Map([
    ['/data/json-1.json', bundle('af:fixture:1')],
    ['/data/d1-1.json', bundle('af:fixture:1')],
    ['/data/json-2.json', bundle('af:fixture:2')],
    ['/data/d1-2.json', bundle('af:fixture:2', 0)],
  ]);
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    fixtures: [
      { fixtureId: 'af:fixture:3', jsonPath: 'json-3.json', d1Path: 'd1-3.json' },
      { fixtureId: 'af:fixture:1', jsonPath: 'json-1.json', d1Path: 'd1-1.json' },
      { fixtureId: 'af:fixture:2', jsonPath: 'json-2.json', d1Path: 'd1-2.json' },
    ],
  };

  const report = runFixtureShadowPlan(plan, {
    baseDirectory: '/data',
    readJson(filePath) {
      if (!files.has(filePath)) throw new Error('missing fixture artifact');
      return files.get(filePath);
    },
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.summary, { total: 3, equal: 1, different: 1, errors: 1 });
  assert.deepEqual(report.fixtures.map(result => result.fixtureId), ['af:fixture:1', 'af:fixture:2', 'af:fixture:3']);
  assert.equal(report.fixtures[1].report.differences.some(item => item.left === 1 && item.right === 0), true);
  assert.equal(report.fixtures[2].error, 'missing fixture artifact');
});

test('plan fixture identity cannot silently point to another entity', () => {
  const report = runFixtureShadowPlan({
    schemaVersion: PLAN_SCHEMA_VERSION,
    fixtures: [{ fixtureId: 'af:fixture:1', jsonPath: 'json.json', d1Path: 'd1.json' }],
  }, {
    readJson(filePath) {
      return filePath.endsWith('json.json') ? bundle('af:fixture:1') : bundle('af:fixture:2');
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.fixtures[0].error, 'plan_fixture_id_mismatch');
  assert.deepEqual(report.fixtures[0].observed, { json: 'af:fixture:1', d1: 'af:fixture:2' });
});

test('empty and duplicate plans are rejected before reading artifacts', () => {
  assert.match(validateFixtureShadowPlan({ schemaVersion: PLAN_SCHEMA_VERSION, fixtures: [] }).join('\n'), /non-empty/);
  assert.match(validateFixtureShadowPlan({
    schemaVersion: PLAN_SCHEMA_VERSION,
    fixtures: [
      { fixtureId: 'af:fixture:1', jsonPath: 'a', d1Path: 'b' },
      { fixtureId: 'af:fixture:1', jsonPath: 'c', d1Path: 'd' },
    ],
  }).join('\n'), /duplicate fixtureId/);

  assert.throws(() => resolveArtifactPath('/safe/plan', '../outside.json'), /escapes plan directory/);
});

test('batch CLI resolves artifact paths relative to the plan and emits a stable report', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-shadow-batch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'json.json'), JSON.stringify(bundle('af:fixture:1')));
  fs.writeFileSync(path.join(directory, 'd1.json'), JSON.stringify(bundle('af:fixture:1')));
  fs.writeFileSync(path.join(directory, 'plan.json'), JSON.stringify({
    schemaVersion: PLAN_SCHEMA_VERSION,
    fixtures: [{ fixtureId: 'af:fixture:1', jsonPath: 'json.json', d1Path: 'd1.json' }],
  }));
  const reportPath = path.join(directory, 'report.json');
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'd1', 'compare-fixture-shadow-batch.js'),
    '--plan', path.join(directory, 'plan.json'),
    '--report', reportPath,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).passed, true);
});
