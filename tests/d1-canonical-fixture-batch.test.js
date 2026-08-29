'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  runCanonicalFixturePlan,
  validateCanonicalFixturePlan,
} = require('../scripts/d1/canonical-fixture-batch');
const { normalizeFixtureBundle } = require('../scripts/d1/fixture-shadow-compare');
const { sha256 } = require('../scripts/d1/fixed-snapshot');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_d1_core.sql'), 'utf8');

function bundle(providerFixtureId) {
  const fixtureId = `af:fixture:${providerFixtureId}`;
  return {
    contractVersion: '2.1.0',
    detailAvailability: 'available',
    fixture: {
      id: fixtureId,
      providerId: providerFixtureId,
      competitionId: 'af:competition:39',
      seasonId: 'af:season:39:2026',
      kickoffUtc: '2026-08-21T20:00:00.000Z',
      dateJst: '2026-08-22',
      productTimeZone: 'Asia/Tokyo',
      round: 'Regular Season - 1',
      referee: null,
      venue: { id: null, providerId: null, name: null, city: null },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
      ingestionState: 'finalized',
      teams: {
        home: { id: 'af:team:40', providerId: 40, name: 'Home FC', logo: null, winner: true },
        away: { id: 'af:team:50', providerId: 50, name: 'Away FC', logo: null, winner: false },
      },
      score: {
        goals: { home: 1, away: 0 },
        halftime: { home: 0, away: 0 },
        fulltime: { home: 1, away: 0 },
        extratime: { home: null, away: null },
        penalty: { home: null, away: null },
      },
      revision: 1,
      reconciledAt: '2026-08-21T22:00:00.000Z',
      provenance: { source: 'api-football', fetchedAt: '2026-08-21T22:00:00.000Z', verification: 'provider', issues: [] },
    },
    competition: {
      id: 'af:competition:39', providerId: 39, name: 'Premier League', country: 'England', logo: null, flag: null,
    },
    season: { id: 'af:season:39:2026', competitionId: 'af:competition:39', providerSeason: 2026, label: '2026' },
    lineups: [],
    events: [],
    teamStats: [],
    playerStats: [],
    sectionStates: {
      events: { presence: 'present' },
      lineups: { presence: 'present' },
      teamStats: { presence: 'present' },
      playerStats: { presence: 'present' },
    },
    overrides: {},
    fieldIssues: {},
  };
}

function createDatabase(file = ':memory:') {
  const database = new DatabaseSync(file);
  database.exec(migration);
  database.exec(`INSERT INTO product_seasons(canonical_id, label, starts_on, ends_on)
    VALUES ('jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30')`);
  return database;
}

function catalog() {
  return {
    productSeasonId: 'jfw:season:2026-27',
    source: { apiVersion: 'v3' },
    competition: { type: 'League', countryCode: 'GB' },
    season: { status: 'active', startsOn: '2026-08-01', endsOn: '2027-05-31' },
  };
}

function contentSha256(value) {
  return sha256(normalizeFixtureBundle(value));
}

function plan(fixtures) {
  return {
    schemaVersion: 'd1-canonical-fixture-import-plan/1',
    productSeasonCanonicalId: 'jfw:season:2026-27',
    fixtures,
  };
}

test('batch registry records imported fixtures and continues to report independent fixture errors', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  const artifacts = new Map([
    ['/plan/bundles/9001.json', bundle(9001)],
    ['/plan/bundles/wrong.json', bundle(9999)],
    ['/plan/catalogs/default.json', catalog()],
  ]);
  const report = await runCanonicalFixturePlan(database, plan([
    { fixtureId: 'af:fixture:9001', bundlePath: 'bundles/9001.json', catalogPath: 'catalogs/default.json' },
    { fixtureId: 'af:fixture:9002', bundlePath: 'bundles/wrong.json', catalogPath: 'catalogs/default.json' },
  ]), {
    baseDirectory: '/plan',
    readJson: filePath => structuredClone(artifacts.get(filePath)),
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.summary, {
    total: 2, imported: 1, alreadyImported: 0, shadowMismatches: 0, errors: 1,
  }, JSON.stringify(report.fixtures));
  assert.equal(report.fixtures[0].contentSha256, contentSha256(bundle(9001)));
  assert.equal(report.fixtures[0].result.shadow.equal, true);
  assert.match(report.fixtures[1].error, /points to bundle af:fixture:9999/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM fixtures').get().count, 1);
});

test('plan validation rejects duplicate IDs and paths outside its directory', async () => {
  const duplicate = plan([
    { fixtureId: 'af:fixture:9001', bundlePath: 'a.json', catalogPath: 'catalog.json' },
    { fixtureId: 'af:fixture:9001', bundlePath: 'b.json', catalogPath: 'catalog.json' },
  ]);
  assert.ok(validateCanonicalFixturePlan(duplicate).some(error => error.includes('duplicate fixtureId')));

  const database = createDatabase();
  try {
    const report = await runCanonicalFixturePlan(database, plan([
      { fixtureId: 'af:fixture:9001', bundlePath: '../outside.json', catalogPath: 'catalog.json' },
    ]), { baseDirectory: '/plan' });
    assert.equal(report.passed, false);
    assert.match(report.fixtures[0].error, /escapes plan directory/);
  } finally {
    database.close();
  }
});

test('batch CLI writes a deterministic registry and reports the second run as idempotent', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-canonical-batch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'bundles'));
  fs.mkdirSync(path.join(directory, 'catalogs'));
  const databasePath = path.join(directory, 'd1.sqlite3');
  const database = createDatabase(databasePath);
  database.close();
  const canonical = bundle(9001);
  fs.writeFileSync(path.join(directory, 'bundles', '9001.json'), JSON.stringify(canonical));
  fs.writeFileSync(path.join(directory, 'catalogs', 'default.json'), JSON.stringify(catalog()));
  fs.writeFileSync(path.join(directory, 'plan.json'), JSON.stringify(plan([{
    fixtureId: canonical.fixture.id,
    bundlePath: 'bundles/9001.json',
    catalogPath: 'catalogs/default.json',
    expectedContentSha256: contentSha256(canonical),
  }])));

  const cli = path.join(__dirname, '..', 'scripts', 'd1', 'import-canonical-fixture-batch.js');
  const firstReport = path.join(directory, 'first-report.json');
  const first = spawnSync(process.execPath, [
    cli, '--plan', path.join(directory, 'plan.json'), '--database', databasePath, '--report', firstReport,
  ], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(fs.readFileSync(firstReport, 'utf8')).summary.imported, 1);

  const secondReport = path.join(directory, 'second-report.json');
  const second = spawnSync(process.execPath, [
    cli, '--plan', path.join(directory, 'plan.json'), '--database', databasePath, '--report', secondReport,
  ], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(secondReport, 'utf8')).summary, {
    alreadyImported: 1,
    errors: 0,
    imported: 0,
    shadowMismatches: 0,
    total: 1,
  });
});
