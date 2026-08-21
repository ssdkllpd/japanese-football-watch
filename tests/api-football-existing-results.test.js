'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  ApiFootballError,
} = require('../scripts/api-football/client');
const {
  RequestBudget,
  aliasMatches,
  buildTargets,
  fixtureMatchesTarget,
  mergeCurrentData,
  mergeFragment,
  matchNeedsCoachEnrichment,
  normalizeProviderName,
  parseStoredScore,
  resolvedTrackedPlayers,
  safeApiErrorDetails,
  selectCoachForDate,
} = require('../scripts/api-football/backfill-existing-results');

const ROOT = path.join(__dirname, '..');
const manifest = require('../config/api-football-existing-results.json');

test('fixed manifest covers every currently stored verified result and nothing else', () => {
  const data = mergeCurrentData(ROOT, manifest.season);
  const targets = buildTargets(data, manifest);

  assert.equal(targets.length, 27);
  assert.equal(new Set(targets.map(target => target.matchId)).size, 27);
  assert.equal(new Set(targets.map(target => target.fixtureDate)).size, 9);
  assert.ok(targets.every(target => Number.isInteger(target.providerLeagueId)));
  assert.ok(targets.every(target => target.discoveryGroup?.key));
  assert.ok(targets.every(target => target.status === 'verified'));
  assert.ok(targets.every(target => Number.isInteger(target.score.homeGoals)));
  assert.ok(targets.every(target => Number.isInteger(target.score.awayGoals)));
});

test('stored score parser excludes penalty shootout text from the away team name', () => {
  assert.deepEqual(parseStoredScore('QPR 1-1 ミルウォール（PK 0-2）'), {
    homeName: 'QPR',
    homeGoals: 1,
    awayGoals: 1,
    awayName: 'ミルウォール',
  });
});

test('fixture matching requires final status, score and both explicit team aliases', () => {
  const target = {
    score: { homeGoals: 1, awayGoals: 3 },
    homeAliases: ['Motherwell'],
    awayAliases: ['SC Freiburg', 'Freiburg'],
  };
  const fixture = {
    fixture: { status: { short: 'FT' } },
    teams: { home: { name: 'Motherwell' }, away: { name: 'SC Freiburg' } },
    goals: { home: 1, away: 3 },
  };

  assert.equal(fixtureMatchesTarget(fixture, target), true);
  assert.equal(fixtureMatchesTarget({ ...fixture, goals: { home: 1, away: 2 } }, target), false);
  assert.equal(fixtureMatchesTarget({ ...fixture, fixture: { status: { short: 'NS' } } }, target), false);
});

test('provider name normalization handles punctuation and accents without fuzzy guessing', () => {
  assert.equal(normalizeProviderName('Vitória S.C.'), 'vitoriasc');
  assert.equal(aliasMatches('St. Truiden', ['St Truiden']), true);
  assert.equal(aliasMatches('Unrelated United', ['Union Saint-Gilloise']), false);
});

test('request budget preserves the configured daily reserve', async () => {
  const budget = new RequestBudget({
    quota: {
      configuredDailyBudget: 100,
      configuredPerMinuteLimit: 10,
      reserveForTrackedFixtures: 20,
    },
  }, { minimumIntervalMs: 0, maxRequests: 80 });
  const client = {
    async get() {
      return { data: { response: [] }, quota: { dailyRemaining: 22, minuteRemaining: 9 } };
    },
  };

  await budget.get(client, '/fixtures', { date: '2026-08-21' });
  assert.equal(budget.requestCount, 1);
  assert.equal(budget.hasCapacity(2), true);
  assert.equal(budget.hasCapacity(3), false);
});

test('request budget honors the configured Pro request interval', () => {
  const budget = new RequestBudget({
    quota: {
      configuredDailyBudget: 7500,
      configuredPerMinuteLimit: 300,
      minimumRequestIntervalMs: 300,
      reserveForTrackedFixtures: 100,
    },
  });

  assert.equal(budget.minimumIntervalMs, 300);
  assert.equal(budget.maxRequests, 7400);
});

test('tracked player IDs resolve only through configured exact aliases in the expected fixture', () => {
  const data = {
    players: [{ name: '後藤啓介', playerId: 'jp-goto', pos: 'FW' }],
  };
  const target = { playerNames: ['後藤啓介'] };
  const fixture = {
    lineups: [{
      team: { id: 1 },
      startXI: [{ player: { id: 99, name: 'K. Goto' } }],
      substitutes: [],
    }],
    players: [],
    events: [],
  };
  const state = { playerResolutions: {} };
  const result = resolvedTrackedPlayers(data, target, fixture, {
    playerAliases: { '後藤啓介': ['Keisuke Goto', 'K. Goto'] },
  }, state, '2026-08-21T00:00:00Z');

  assert.equal(result.unresolved.length, 0);
  assert.equal(result.tracked[0].apiFootballPlayerId, 99);
  assert.equal(state.playerResolutions['後藤啓介'].method, 'explicit_alias_in_expected_fixture');
});

test('fragment merge upserts provider IDs without dropping existing provider namespaces', () => {
  const merged = mergeFragment({
    sources: {},
    matchUpdates: [],
    playerMatchStats: [],
    gaResultsAdd: [],
    playerUpdates: [{
      playerId: 'jp-one',
      name: '選手一',
      providerIds: { manualSource: { player: 'manual-1' } },
    }],
  }, {
    sources: {},
    matchUpdates: [],
    playerMatchStats: [],
    gaResultsAdd: [],
    playerUpdates: [{
      playerId: 'jp-one',
      name: '選手一',
      providerIds: { apiFootball: { player: 10 } },
    }],
  });

  assert.equal(merged.playerUpdates[0].providerIds.manualSource.player, 'manual-1');
  assert.equal(merged.playerUpdates[0].providerIds.apiFootball.player, 10);
});

test('persisted API errors retain diagnostics but redact the repository secret', () => {
  const error = new ApiFootballError('provider error', {
    status: 200,
    apiErrors: { plan: 'secret-value cannot access this date' },
  });
  assert.deepEqual(safeApiErrorDetails(error, 'secret-value'), {
    status: 200,
    apiErrors: { plan: '[REDACTED] cannot access this date' },
  });
});

test('coach fallback requires one exact team career assignment covering the fixture date', () => {
  const rows = [{
    id: 90,
    name: 'Previous Coach',
    career: [{ team: { id: 735 }, start: '2025-07-01', end: '2026-05-31' }],
  }, {
    id: 91,
    name: 'Current Coach',
    career: [{ team: { id: 735 }, start: '2026-06-01', end: null }],
  }];

  assert.equal(selectCoachForDate(rows, 735, '2026-08-21').id, 91);
  assert.equal(selectCoachForDate(rows, 999, '2026-08-21'), null);
});

test('completed matches are reopened only when a lineup team lacks a coach portrait', () => {
  const fragment = {
    matchUpdates: [{
      matchId: 'complete',
      formationData: { teams: [{ lineupAvailable: true, coach: { name: 'Coach', photo: 'https://example.com/coach.png' } }] },
    }, {
      matchId: 'missing',
      formationData: { teams: [{ lineupAvailable: true, coach: null }] },
    }],
  };

  assert.equal(matchNeedsCoachEnrichment(fragment, 'complete'), false);
  assert.equal(matchNeedsCoachEnrichment(fragment, 'missing'), true);
});
