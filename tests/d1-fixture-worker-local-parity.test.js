'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const {
  correctionDefinitions,
  importFixtureBundle,
} = require('../scripts/d1/fixture-bundle-importer');

const migrations = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
  .filter(file => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort()
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'migrations', file), 'utf8'));
const observedAt = '2026-08-21T21:01:00.000Z';

function provenance() {
  return { source: 'api-football', fetchedAt: observedAt, verification: 'provider', issues: [] };
}

function bundle() {
  return {
    contractVersion: '2.1.0',
    detailAvailability: 'available',
    fixture: {
      id: 'af:fixture:9001', providerId: 9001,
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
      kickoffUtc: '2026-08-21T20:00:00.000Z', dateJst: '2026-08-22',
      productTimeZone: 'Asia/Tokyo', round: 'Regular Season - 1', referee: null,
      venue: { id: 'af:venue:10', providerId: 10, name: 'Example Stadium', city: 'London' },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
      ingestionState: 'finalized',
      teams: {
        home: { id: 'af:team:40', providerId: 40, name: 'Home FC', logo: null, winner: true },
        away: { id: 'af:team:50', providerId: 50, name: 'Away FC', logo: null, winner: false },
      },
      score: {
        goals: { home: 2, away: 0 }, halftime: { home: 1, away: 0 },
        fulltime: { home: 2, away: 0 }, extratime: { home: null, away: null },
        penalty: { home: null, away: null },
      },
      revision: 1, reconciledAt: observedAt, provenance: provenance(),
    },
    competition: {
      id: 'af:competition:39', providerId: 39, name: 'Premier League',
      country: 'England', logo: null, flag: null,
    },
    season: {
      id: 'af:season:39:2026', competitionId: 'af:competition:39',
      providerSeason: 2026, label: '2026',
    },
    lineups: [], events: [],
    teamStats: [{
      teamId: 'af:team:40',
      values: { total_shots: 12, ball_possession: 60.5, fouls: 3, offsides: 0 },
      provenance: provenance(),
    }],
    playerStats: [{
      fixtureId: 'af:fixture:9001', playerId: 'af:player:1001', playerProviderId: 1001,
      playerName: 'Example Player', playerPhoto: null, teamId: 'af:team:40',
      position: 'F', starter: false, captain: false,
      values: { minutes: 15, rating: 7.4, shots: 2, shotsOnTarget: 1, passes: 8 },
      fieldStates: {}, fieldIssues: {}, provenance: provenance(),
    }],
    sectionStates: {
      events: { presence: 'present' }, lineups: { presence: 'present' },
      teamStats: { presence: 'present' }, playerStats: { presence: 'present' },
    },
    overrides: {}, fieldIssues: {},
  };
}

function catalog() {
  return {
    productSeasonId: 'jfw:season:2026-27', source: { apiVersion: 'v3' },
    competition: { type: 'League', countryCode: 'GB' },
    season: { status: 'active', startsOn: '2026-08-01', endsOn: '2027-05-31', finalizedOn: null },
  };
}

function database() {
  const db = new DatabaseSync(':memory:');
  migrations.forEach(sql => db.exec(sql));
  db.exec(`INSERT INTO product_seasons(canonical_id, label, starts_on, ends_on)
    VALUES ('jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30')`);
  return db;
}

function databaseState(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'
    ORDER BY name`).all().map(row => row.name);
  return Object.fromEntries(tables.map(name => {
    const rows = db.prepare(`SELECT * FROM ${name}`).all()
      .map(row => JSON.parse(JSON.stringify(row)))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return [name, rows];
  }));
}

test('Worker fixture publishing and local importer persist identical database state', async t => {
  const local = database();
  const worker = database();
  t.after(() => { local.close(); worker.close(); });
  const value = bundle();
  const definitions = {
    schemaVersion: 'd1-fixture-correction-definitions/1', fixtureId: value.fixture.id,
    definitions: correctionDefinitions(value),
  };

  importFixtureBundle(local, value, catalog(), definitions);

  const { publishFixtureFromR2 } = await import('../admin-worker/fixture-ingest.mjs');
  const key = `football/v2/competitions/${value.fixture.competitionId}`
    + `/seasons/${value.fixture.seasonId}/fixtures/${value.fixture.id}.json`;
  const report = await publishFixtureFromR2({
    FOOTBALL_DB: createLocalD1(worker),
    FOOTBALL_DATA: { async get(requested) {
      return requested === key ? { async text() { return JSON.stringify(value); } } : null;
    } },
  }, {
    operation: 'fixture_publish', fixtureId: value.fixture.id,
    competitionId: value.fixture.competitionId, seasonId: value.fixture.seasonId,
    catalog: catalog(), correctionDefinitions: definitions,
  });

  assert.equal(report.imported, true);
  assert.deepEqual(databaseState(worker), databaseState(local));
});
