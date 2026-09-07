'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../scripts/v2/fixture-contract');

function sampleFixture() {
  return {
    fixture: {
      id: 123456,
      date: '2026-08-21T20:00:00+00:00',
      referee: 'Ref Name',
      venue: { id: 55, name: 'Example Stadium', city: 'London' },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
    },
    league: {
      id: 39,
      name: 'Premier League',
      country: 'England',
      season: 2026,
      round: 'Regular Season - 1',
      logo: 'https://example.com/league.png',
    },
    teams: {
      home: { id: 40, name: 'Home FC', logo: 'https://example.com/home.png', winner: true },
      away: { id: 50, name: 'Away FC', logo: 'https://example.com/away.png', winner: false },
    },
    goals: { home: 2, away: 1 },
    score: {
      halftime: { home: 1, away: 0 },
      fulltime: { home: 2, away: 1 },
      extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
    events: [{
      time: { elapsed: 12, extra: null },
      team: { id: 40, name: 'Home FC' },
      player: { id: 1001, name: 'Player One' },
      assist: { id: 1002, name: 'Player Two' },
      type: 'Goal',
      detail: 'Normal Goal',
    }],
    lineups: [{
      team: { id: 40, name: 'Home FC' },
      formation: '4-2-3-1',
      coach: { id: 700, name: 'Coach Home' },
      startXI: [{ player: { id: 1001, name: 'Player One', number: 9, pos: 'F', grid: '4:1' } }],
      substitutes: [],
    }],
    players: [{
      team: { id: 40, name: 'Home FC' },
      players: [{
        player: { id: 1001, name: 'Player One', photo: 'https://example.com/p1.png' },
        statistics: [{
          games: { minutes: 90, position: 'F', rating: '7.8', captain: false, substitute: false },
          shots: { total: 3, on: 2 },
          goals: { total: 1, assists: 0, conceded: 0, saves: null },
          passes: { total: 24, key: 1, accuracy: 82 },
          tackles: { total: 1, blocks: 0, interceptions: 0 },
          duels: { total: 8, won: 4 },
          dribbles: { attempts: 2, success: 1, past: 0 },
          fouls: { drawn: 1, committed: 1 },
          cards: { yellow: 0, red: 0 },
          penalty: { won: 0, commited: 0, scored: 0, missed: 0, saved: null },
        }],
      }],
    }],
    statistics: [{
      team: { id: 40, name: 'Home FC' },
      statistics: [
        { type: 'Ball Possession', value: '56%' },
        { type: 'Total Shots', value: 11 },
      ],
    }],
  };
}

test('general fixture contract uses provider-native IDs, UTC canonical time and JST date index', () => {
  const bundle = contract.normalizeFixtureBundle(sampleFixture(), {
    fetchedAt: '2026-08-21T21:00:00Z',
    finalized: true,
  });

  assert.equal(bundle.fixture.id, 'af:fixture:123456');
  assert.equal(bundle.fixture.competitionId, 'af:competition:39');
  assert.equal(bundle.fixture.seasonId, 'af:season:39:2026');
  assert.equal(bundle.fixture.teams.home.id, 'af:team:40');
  assert.equal(bundle.fixture.kickoffUtc, '2026-08-21T20:00:00.000Z');
  assert.equal(bundle.fixture.dateJst, '2026-08-22');
  assert.equal(bundle.fixture.productTimeZone, 'Asia/Tokyo');
  assert.equal(bundle.fixture.ingestionState, 'finalized');
  assert.equal(bundle.contractVersion, '2.1.0');
  assert.equal(bundle.detailAvailability, 'available');
  assert.deepEqual(contract.validateFixtureBundle(bundle), []);
});

test('2.1 fixture publisher rejects a bundle with missing or invalid detail availability', () => {
  const missing = contract.normalizeFixtureBundle(sampleFixture());
  delete missing.detailAvailability;
  assert.deepEqual(contract.validateFixtureBundle(missing), ['detailAvailability must be available or unavailable']);
  missing.detailAvailability = 'partial';
  assert.deepEqual(contract.validateFixtureBundle(missing), ['detailAvailability must be available or unavailable']);
});

test('all players are normalized as general football facts without a Japanese registry gate', () => {
  const bundle = contract.normalizeFixtureBundle(sampleFixture(), { finalized: true });
  assert.equal(bundle.playerStats.length, 1);
  assert.equal(bundle.playerStats[0].playerId, 'af:player:1001');
  assert.equal(bundle.playerStats[0].values.goals, 1);
  assert.equal(bundle.playerStats[0].values.assists, 0);
  assert.equal(bundle.playerStats[0].values.rating, 7.8);
  assert.deepEqual(bundle.playerStats[0].fieldStates.saves, { presence: 'not_applicable' });
});

test('section presence distinguishes not fetched from fetched empty data', () => {
  const notFetched = sampleFixture();
  delete notFetched.events;
  const a = contract.normalizeFixtureBundle(notFetched);
  assert.equal(a.sectionStates.events.presence, 'not_fetched');

  const fetchedEmpty = sampleFixture();
  fetchedEmpty.events = [];
  const b = contract.normalizeFixtureBundle(fetchedEmpty);
  assert.equal(b.sectionStates.events.presence, 'present');
});

test('manual correction stays active while provider value matches the corrected baseline', () => {
  const bundle = contract.normalizeFixtureBundle(sampleFixture(), { finalized: true });
  const corrected = contract.applyManualCorrections(bundle, [{
    path: 'fixture.score.fulltime.home',
    value: 3,
    correctedProviderValue: 2,
    reason: 'Official record',
    sourceUrl: 'https://example.com/official',
    verifiedAt: '2026-08-21T22:00:00Z',
  }]);

  assert.equal(corrected.fixture.score.fulltime.home, 3);
  assert.equal(corrected.overrides['fixture.score.fulltime.home'].status, 'active');
  assert.deepEqual(corrected.fieldIssues, {});
});

test('manual correction becomes inactive when provider catches up to the verified value', () => {
  const fixture = sampleFixture();
  fixture.score.fulltime.home = 3;
  const bundle = contract.normalizeFixtureBundle(fixture, { finalized: true });
  const corrected = contract.applyManualCorrections(bundle, [{
    path: 'fixture.score.fulltime.home',
    value: 3,
    correctedProviderValue: 2,
    reason: 'Official record',
  }]);

  assert.equal(corrected.fixture.score.fulltime.home, 3);
  assert.equal(corrected.overrides['fixture.score.fulltime.home'].status, 'provider_caught_up');
  assert.deepEqual(corrected.fieldIssues, {});
});

test('manual correction enters review instead of silently winning when provider changes elsewhere', () => {
  const fixture = sampleFixture();
  fixture.score.fulltime.home = 4;
  const bundle = contract.normalizeFixtureBundle(fixture, { finalized: true });
  const corrected = contract.applyManualCorrections(bundle, [{
    path: 'fixture.score.fulltime.home',
    value: 3,
    correctedProviderValue: 2,
    reason: 'Official record',
  }]);

  assert.equal(corrected.fixture.score.fulltime.home, 4);
  assert.equal(corrected.overrides['fixture.score.fulltime.home'].status, 'review_required');
  assert.deepEqual(corrected.fieldIssues['fixture.score.fulltime.home'], ['conflict']);
  assert.equal(corrected.fixture.ingestionState, 'needs_review');
});

test('R2 keys preserve fixture as canonical access unit with explicit JST index', () => {
  const bundle = contract.normalizeFixtureBundle(sampleFixture(), { finalized: true });
  assert.equal(
    contract.r2FixtureKey(bundle),
    'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/fixtures/af:fixture:123456.json'
  );
  assert.equal(contract.r2FixturePointerKey(bundle.fixture.id), 'football/v2/indexes/fixture/af:fixture:123456.json');
  assert.equal(contract.r2DateIndexKey(bundle.fixture.dateJst), 'football/v2/indexes/date-jst/2026-08-22.json');
});
