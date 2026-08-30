'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { compareFixtureBundles, normalizeFixtureBundle } = require('../scripts/d1/fixture-shadow-compare');

function bundle() {
  return {
    contractVersion: '2.0.0',
    fixture: {
      id: 'af:fixture:9001',
      kickoffUtc: '2026-08-21T20:00:00Z',
      reconciledAt: '2026-08-21T22:00:00+00:00',
      score: { goals: { home: 1, away: 0 } },
      provenance: { source: 'api-football', fetchedAt: '2026-08-21T22:00:00Z', issues: ['late', 'conflict'] },
    },
    events: [
      { id: 'event:2', elapsed: 80, extra: null, type: 'substitution' },
      { id: 'event:1', elapsed: 12, extra: null, type: 'goal' },
    ],
    lineups: [
      { teamId: 'af:team:2', startXI: [{ id: 'af:player:2', number: 9 }] },
      { teamId: 'af:team:1', startXI: [{ id: 'af:player:1', number: 1 }] },
    ],
    playerStats: [
      { playerId: 'af:player:2', values: { goals: 0, assists: null } },
      { playerId: 'af:player:1', values: { goals: 1, assists: 0 } },
    ],
    teamStats: [],
    sectionStates: { events: { presence: 'present' } },
    overrides: {
      'fixture.score.goals.home': {
        status: 'active',
        value: 1,
        verifiedAt: '2026-08-21T21:30:00Z',
      },
    },
    fieldIssues: {},
  };
}

test('2.0 JSON and 2.1 D1 bundles compare equal after safe semantic normalization', () => {
  const jsonBundle = bundle();
  const d1Bundle = JSON.parse(JSON.stringify(jsonBundle));
  d1Bundle.contractVersion = '2.1.0';
  d1Bundle.detailAvailability = 'available';
  d1Bundle.fixture.kickoffUtc = '2026-08-21T20:00:00.000Z';
  d1Bundle.fixture.reconciledAt = '2026-08-21T22:00:00.000Z';
  d1Bundle.fixture.provenance.fetchedAt = '2026-08-21T22:00:00.000Z';
  d1Bundle.overrides['fixture.score.goals.home'].verifiedAt = '2026-08-21T21:30:00.000Z';
  d1Bundle.lineups.reverse();
  d1Bundle.playerStats.reverse();
  d1Bundle.fixture.provenance.issues.reverse();

  const report = compareFixtureBundles(jsonBundle, d1Bundle);

  assert.equal(report.equal, true);
  assert.equal(report.fixtureId, 'af:fixture:9001');
  assert.equal(report.json.contractVersion, '2.1.0');
  assert.equal(report.json.semanticSha256, report.d1.semanticSha256);
  assert.deepEqual(report.differences, []);
});

test('event and lineup-entry order are part of semantic parity', () => {
  const jsonBundle = bundle();
  const reorderedEvents = bundle();
  reorderedEvents.events.reverse();
  assert.equal(compareFixtureBundles(jsonBundle, reorderedEvents).equal, false);

  jsonBundle.lineups[0].startXI.push({ id: 'af:player:3', number: 10 });
  const reorderedLineup = JSON.parse(JSON.stringify(jsonBundle));
  reorderedLineup.lineups[0].startXI.reverse();
  const report = compareFixtureBundles(jsonBundle, reorderedLineup);
  assert.equal(report.equal, false);
  assert.equal(report.comparisonCoverage.orderedArrays.includes('lineups[].startXI'), true);
});

test('ordered array matching is limited to declared contract paths', () => {
  const left = bundle();
  const right = bundle();
  left.fixture.events = [{ id: 'nested:2' }, { id: 'nested:1' }];
  right.fixture.events = [...left.fixture.events].reverse();

  assert.equal(compareFixtureBundles(left, right).equal, true);
});

test('explicit zero never compares equal to null', () => {
  const left = bundle();
  const right = bundle();
  right.playerStats[0].values.goals = null;

  const report = compareFixtureBundles(left, right);

  assert.equal(report.equal, false);
  assert.equal(report.differences.some(item => item.kind === 'value_mismatch' && item.left === 0 && item.right === null), true);
});

test('missing values and correction-state changes remain visible differences', () => {
  const left = bundle();
  const right = bundle();
  delete right.playerStats[0].values.assists;
  right.overrides['fixture.score.goals.home'].status = 'review_required';

  const report = compareFixtureBundles(left, right);

  assert.equal(report.equal, false);
  assert.equal(report.differences.some(item => item.kind === 'missing_right'), true);
  assert.equal(report.differences.some(item => item.path.endsWith('/status') && item.right === 'review_required'), true);
});

test('unsupported contract versions fail closed', () => {
  const unsupported = bundle();
  unsupported.contractVersion = '3.0.0';
  assert.throws(() => normalizeFixtureBundle(unsupported), /Unsupported fixture contract version/);

  const malformed = bundle();
  delete malformed.fixture.id;
  assert.throws(() => normalizeFixtureBundle(malformed), /fixture.id is required/);
});

test('diff limit reports truncation without exceeding the requested size', () => {
  const left = bundle();
  const right = bundle();
  right.fixture.score.goals = { home: 2, away: 3 };

  const report = compareFixtureBundles(left, right, { limit: 1 });

  assert.equal(report.differences.length, 1);
  assert.equal(report.truncated, true);
});

test('CLI exits zero for parity and one with a machine-readable diff for mismatch', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-shadow-compare-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const jsonPath = path.join(directory, 'json.json');
  const d1Path = path.join(directory, 'd1.json');
  const reportPath = path.join(directory, 'report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(bundle()));
  fs.writeFileSync(d1Path, JSON.stringify({ ...bundle(), contractVersion: '2.1.0', detailAvailability: 'available' }));
  const cli = path.join(__dirname, '..', 'scripts', 'd1', 'compare-fixture-shadow.js');

  const equal = spawnSync(process.execPath, [cli, '--json', jsonPath, '--d1', d1Path, '--report', reportPath], { encoding: 'utf8' });
  assert.equal(equal.status, 0, equal.stderr);
  assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).equal, true);

  const mismatch = bundle();
  mismatch.fixture.score.goals.home = 0;
  fs.writeFileSync(d1Path, JSON.stringify(mismatch));
  const different = spawnSync(process.execPath, [cli, '--json', jsonPath, '--d1', d1Path, '--report', reportPath], { encoding: 'utf8' });
  assert.equal(different.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).equal, false);
});
