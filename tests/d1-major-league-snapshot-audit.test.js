'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

test('snapshot audit assigns a stable global index across all 564 requests', async () => {
  const { requestLocation } = await import('../scripts/d1/audit-major-league-snapshot.mjs');
  const requests = [
    ...Array.from({ length: 10 }, (_, index) => ({
      operation: 'major_league_core_publish', competitionId: `af:competition:${index + 1}`,
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      operation: 'major_league_standings_publish', competitionId: `af:competition:${index + 1}`,
    })),
    ...Array.from({ length: 365 }, (_, index) => ({
      operation: 'fixture_migration_publish', fixtureId: `af:fixture:${1000 + index}`,
    })),
    ...Array.from({ length: 178 }, (_, index) => ({
      operation: 'major_league_date_coverage_publish', date: `date-${index + 1}`,
    })),
    { operation: 'migration_verify' },
  ];
  const locations = requests.map(requestLocation);
  assert.equal(locations.length, 564);
  assert.equal(locations[0].globalRequestIndex, 1);
  assert.equal(locations[19].globalRequestIndex, 20);
  assert.deepEqual(locations[20], {
    globalRequestIndex: 21,
    operation: 'fixture_migration_publish',
    leagueId: null,
    fixtureId: 'af:fixture:1000',
    date: null,
  });
  assert.equal(locations[563].globalRequestIndex, 564);
  assert.equal(locations[563].operation, 'migration_verify');
});

test('snapshot audit accepts only the intended persistence states for a nameless identified venue', async t => {
  const { venuePersistenceIssue } = await import('../scripts/d1/audit-major-league-snapshot.mjs');
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE venues(id INTEGER PRIMARY KEY, canonical_id TEXT UNIQUE, name TEXT NOT NULL);
    CREATE TABLE fixtures(canonical_id TEXT PRIMARY KEY, venue_id INTEGER);
    INSERT INTO venues(id, canonical_id, name) VALUES (1, 'af:venue:10', 'Existing Ground');
    INSERT INTO fixtures(canonical_id, venue_id) VALUES ('af:fixture:1', 1), ('af:fixture:2', NULL);
  `);
  const identified = { id: 'af:venue:10', providerId: 10, name: null, city: null };
  const unresolved = { id: 'af:venue:20', providerId: 20, name: null, city: null };
  assert.equal(venuePersistenceIssue(database, 'af:fixture:1', identified), null);
  assert.equal(venuePersistenceIssue(database, 'af:fixture:2', unresolved), null);
  assert.equal(
    venuePersistenceIssue(database, 'af:fixture:2', identified).reason,
    'existing_nameless_venue_not_reused',
  );
});
