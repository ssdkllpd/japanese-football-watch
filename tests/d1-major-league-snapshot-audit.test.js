'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

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
