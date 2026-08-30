'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { importFixtureBundle, validateBundle } = require('../scripts/d1/fixture-bundle-importer');
const { FixtureRepository } = require('../scripts/d1/fixture-repository');
const { compareFixtureBundles } = require('../scripts/d1/fixture-shadow-compare');
const { importAndCompare } = require('../scripts/d1/import-fixture-bundle');
const { createLocalD1 } = require('../scripts/d1/local-d1');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_d1_core.sql'), 'utf8');
const OBSERVED_AT = '2026-08-21T21:01:00.000Z';

function provenance() {
  return { source: 'api-football', fetchedAt: OBSERVED_AT, verification: 'provider', issues: [] };
}

function fixtureBundle() {
  return {
    contractVersion: '2.1.0',
    detailAvailability: 'available',
    fixture: {
      id: 'af:fixture:9001', providerId: 9001,
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
      kickoffUtc: '2026-08-21T20:00:00.000Z', dateJst: '2026-08-22', productTimeZone: 'Asia/Tokyo',
      round: 'Regular Season - 1', referee: 'Ref Example',
      venue: { id: 'af:venue:10', providerId: 10, name: 'Example Stadium', city: 'London' },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 }, ingestionState: 'finalized',
      teams: {
        home: { id: 'af:team:40', providerId: 40, name: 'Home FC', logo: 'https://cdn.example/home.png', winner: true },
        away: { id: 'af:team:50', providerId: 50, name: 'Away FC', logo: 'https://cdn.example/away.png', winner: false },
      },
      score: {
        goals: { home: 2, away: 0 }, halftime: { home: 1, away: 0 },
        fulltime: { home: 3, away: 0 }, extratime: { home: null, away: null }, penalty: { home: null, away: null },
      },
      revision: 1, reconciledAt: OBSERVED_AT, provenance: provenance(),
    },
    competition: {
      id: 'af:competition:39', providerId: 39, name: 'Premier League', country: 'England',
      logo: 'https://cdn.example/competition.png', flag: 'https://cdn.example/flag.png',
    },
    season: { id: 'af:season:39:2026', competitionId: 'af:competition:39', providerSeason: 2026, label: '2026' },
    lineups: [{
      teamId: 'af:team:40', formation: '4-3-3', fieldStates: { formation: { presence: 'present' } },
      coach: { id: 'af:coach:501', providerId: 501, name: 'Example Coach', photo: 'https://cdn.example/coach.png' },
      startXI: [{
        id: 'af:player:1001', providerId: 1001, name: 'Example Player', number: 7,
        position: 'F', grid: '1:1', role: 'starter',
      }],
      substitutes: [], provenance: provenance(),
    }],
    events: [{
      id: 'event:goal:12', type: 'goal', detail: 'Normal Goal', comments: null, elapsed: 12, extra: null,
      teamId: 'af:team:40', playerId: 'af:player:1001', relatedPlayerId: null, provenance: provenance(),
    }],
    teamStats: [{
      teamId: 'af:team:40', values: { total_shots: 12, fouls: 0, offsides: 0 }, provenance: provenance(),
    }],
    playerStats: [{
      fixtureId: 'af:fixture:9001', playerId: 'af:player:1001', playerProviderId: 1001,
      playerName: 'Example Player', playerPhoto: 'https://cdn.example/player.png', teamId: 'af:team:40',
      position: 'F', starter: true, captain: true,
      values: { minutes: 90, rating: 8.2, goals: 1, assists: 0, expectedAssists: 0 },
      fieldStates: { assists: { presence: 'present' }, saves: { presence: 'not_applicable' } },
      fieldIssues: { assists: ['conflict'] }, provenance: provenance(),
    }],
    sectionStates: {
      events: { presence: 'present' }, lineups: { presence: 'present' },
      teamStats: { presence: 'present' }, playerStats: { presence: 'present' },
    },
    overrides: {
      'fixture.score.fulltime.home': {
        status: 'active', correctedProviderValue: 2, value: 3, reason: 'Official match report',
        sourceUrl: 'https://example.com/report', verifiedAt: '2026-08-21T21:00:00.000Z', reconciledAt: OBSERVED_AT,
      },
    },
    fieldIssues: {},
  };
}

function catalog() {
  return {
    productSeasonId: 'jfw:season:2026-27', source: { apiVersion: 'v3' },
    competition: { type: 'League', countryCode: 'GB' },
    season: { status: 'active', startsOn: '2026-08-01', endsOn: '2027-05-31' },
  };
}

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(migration);
  database.exec(`INSERT INTO product_seasons(canonical_id, label, starts_on, ends_on)
    VALUES ('jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30')`);
  return database;
}

test('complete 2.1 bundle imports transactionally and has semantic round-trip parity', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  const bundle = fixtureBundle();

  const report = await importAndCompare(database, bundle, catalog());
  const imported = report.imported;
  const resolved = await new FixtureRepository(createLocalD1(database))
    .resolveFixture(bundle.fixture.id);

  assert.equal(imported.imported, true);
  assert.deepEqual(imported.counts, { events: 1, lineups: 1, playerStats: 1, teamStats: 1 });
  assert.equal(resolved.source, 'd1');
  assert.equal(report.passed, true, JSON.stringify(report.shadow.differences));
  assert.equal(resolved.bundle.playerStats[0].values.assists, 0);
  assert.equal(resolved.bundle.playerStats[0].values.expectedAssists, 0);
  assert.equal(resolved.bundle.teamStats[0].values.fouls, 0);
  assert.equal(resolved.bundle.teamStats[0].values.offsides, 0);
});

test('shadow parity detects correction provenance drift stored in D1', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  const bundle = fixtureBundle();
  importFixtureBundle(database, bundle, catalog());
  database.exec(`UPDATE correction_states SET reason = 'Tampered reason',
    source_url = 'https://example.com/tampered',
    verified_at = '2026-08-21T20:59:00.000Z'`);

  const resolved = await new FixtureRepository(createLocalD1(database)).resolveFixture(bundle.fixture.id);
  const comparison = compareFixtureBundles(bundle, resolved.bundle);

  assert.equal(comparison.equal, false);
  assert.equal(comparison.differences.some(item => item.path.endsWith('/reason')), true);
  assert.equal(comparison.differences.some(item => item.path.endsWith('/sourceUrl')), true);
  assert.equal(comparison.differences.some(item => item.path.endsWith('/verifiedAt')), true);
});

test('D1 round-trip preserves lineup entry order and detects stored order drift', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  const bundle = fixtureBundle();
  bundle.lineups[0].startXI.push({
    id: 'af:player:1002', providerId: 1002, name: 'Second Player', number: 8,
    position: 'M', grid: '2:1', role: 'starter',
  });
  importFixtureBundle(database, bundle, catalog());

  const before = await new FixtureRepository(createLocalD1(database)).resolveFixture(bundle.fixture.id);
  assert.deepEqual(before.bundle.lineups[0].startXI.map(player => player.id),
    ['af:player:1001', 'af:player:1002']);

  database.exec(`
    UPDATE fixture_lineup_entries SET entry_order = entry_order + 10;
    UPDATE fixture_lineup_entries SET entry_order = CASE entry_order WHEN 10 THEN 1 ELSE 0 END;
  `);
  const after = await new FixtureRepository(createLocalD1(database)).resolveFixture(bundle.fixture.id);
  const comparison = compareFixtureBundles(bundle, after.bundle);
  assert.equal(comparison.equal, false);
  assert.equal(comparison.differences.some(item => item.path.includes('/startXI/')), true);
});

test('a replacement revision removes stale correction state and superseded detail', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  const original = fixtureBundle();
  importFixtureBundle(database, original, catalog());
  const replacement = JSON.parse(JSON.stringify(original));
  const nextObservedAt = '2026-08-22T01:00:00.000Z';
  replacement.fixture.revision = 2;
  replacement.fixture.reconciledAt = nextObservedAt;
  replacement.fixture.provenance.fetchedAt = nextObservedAt;
  for (const key of ['lineups', 'events', 'teamStats', 'playerStats']) {
    for (const item of replacement[key]) item.provenance.fetchedAt = nextObservedAt;
  }
  replacement.fixture.score.fulltime.home = 2;
  replacement.overrides = {};

  const report = await importAndCompare(database, replacement, catalog());

  assert.equal(report.passed, true, JSON.stringify(report.shadow.differences));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM correction_states').get().count, 0);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM fixture_revisions
    WHERE lifecycle_state = 'superseded'`).get().count, 1);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM fixture_events event
    JOIN fixture_revisions revision ON revision.id = event.fixture_revision_id
    WHERE revision.lifecycle_state = 'superseded'`).get().count, 0);
});

test('identical published content is a no-op with no new revision', t => {
  const database = createDatabase();
  t.after(() => database.close());
  const bundle = fixtureBundle();

  importFixtureBundle(database, bundle, catalog());
  const repeated = importFixtureBundle(database, bundle, catalog());

  assert.equal(repeated.imported, false);
  assert.equal(repeated.reason, 'already_published');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM fixture_revisions').get().count, 1);
});

test('invalid next revision rolls the attempted replacement back to the published snapshot', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  const original = fixtureBundle();
  importFixtureBundle(database, original, catalog());
  const invalid = fixtureBundle();
  invalid.fixture.revision = 3;
  invalid.fixture.score.goals.home = 4;

  assert.throws(() => importFixtureBundle(database, invalid, catalog()), /next revision \(2\)/);
  const resolved = await new FixtureRepository(createLocalD1(database))
    .resolveFixture(original.fixture.id);

  assert.equal(compareFixtureBundles(original, resolved.bundle).equal, true);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM fixture_revisions
    WHERE lifecycle_state = 'published'`).get().count, 1);
});

test('legacy enrichment with no canonical UTC kickoff fails closed before any writes', t => {
  const database = createDatabase();
  t.after(() => database.close());
  const incomplete = fixtureBundle();
  incomplete.fixture.kickoffUtc = '2026-08-21 21:00';

  assert.throws(() => validateBundle(incomplete, catalog()), /UTC ISO timestamp/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM fixtures').get().count, 0);
});

test('the importer rejects pre-2.1 bundles instead of silently upcasting persisted data', () => {
  const oldBundle = fixtureBundle();
  oldBundle.contractVersion = '2.0.0';

  assert.throws(() => validateBundle(oldBundle, catalog()), /contractVersion must be 2\.1\.0/);
});
