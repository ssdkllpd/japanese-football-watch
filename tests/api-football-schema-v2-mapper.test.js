const test = require('node:test');
const assert = require('node:assert/strict');
const {
  apiFootballMediaUrl,
  mapFixtureToSchemaV2,
  normalizeTrackedPlayers,
  safeImageUrl,
} = require('../scripts/api-football/schema-v2-mapper');
const {
  inventoryFixture,
  pathPresent,
} = require('../scripts/api-football/field-inventory');

function baseFixture(overrides = {}) {
  return {
    fixture: {
      id: 9001,
      date: '2026-08-20T20:30:00+09:00',
      status: { short: 'FT' },
    },
    league: {
      id: 999,
      name: 'UEFA Conference League',
      season: 2026,
      round: 'Play-off 1st leg',
    },
    teams: {
      home: { id: 300, name: 'Motherwell' },
      away: { id: 200, name: 'SC Freiburg' },
    },
    goals: { home: 1, away: 3 },
    events: [],
    lineups: [],
    players: [],
    ...overrides,
  };
}

const gotoRegistry = [{
  playerId: 'jp-goto-keisuke',
  name: '後藤啓介',
  apiFootballPlayerId: 100,
  pos: 'FW',
  club: 'フライブルク',
}];

test('goal event creates a tracked match record and G/A entry even when player statistics are absent', () => {
  const fixture = baseFixture({
    events: [
      {
        team: { id: 300, name: 'Motherwell' },
        player: { id: 301, name: 'Motherwell scorer' },
        assist: { id: null, name: null },
        type: 'Goal',
        detail: 'Normal Goal',
      },
      {
        team: { id: 200, name: 'SC Freiburg' },
        player: { id: 201, name: 'Freiburg scorer one' },
        assist: { id: null, name: null },
        type: 'Goal',
        detail: 'Normal Goal',
      },
      {
        team: { id: 200, name: 'SC Freiburg' },
        player: { id: 202, name: 'Freiburg scorer two' },
        assist: { id: null, name: null },
        type: 'Goal',
        detail: 'Normal Goal',
      },
      {
        time: { elapsed: 90, extra: 6 },
        team: { id: 200, name: 'SC Freiburg' },
        player: { id: 100, name: 'Keisuke Goto' },
        assist: { id: 101, name: 'Teammate' },
        type: 'Goal',
        detail: 'Normal Goal',
      },
    ],
    lineups: [{
      team: { id: 200, name: 'SC Freiburg' },
      startXI: [],
      substitutes: [{ player: { id: 100, name: 'Keisuke Goto', pos: 'F' } }],
    }],
  });

  const fragment = mapFixtureToSchemaV2(fixture, {
    trackedPlayers: gotoRegistry,
    season: '2026-27',
    matchId: 'uecl-2026-08-20-motherwell-freiburg',
    clubNamesByProviderId: { 200: 'フライブルク', 300: 'マザーウェル' },
  });

  assert.equal(fragment.playerMatchStats.length, 1);
  const record = fragment.playerMatchStats[0];
  assert.equal(record.playerId, 'jp-goto-keisuke');
  assert.equal(record.club, 'フライブルク');
  assert.equal(record.appearance, true);
  assert.equal(record.start, false);
  assert.equal(record.bench, true);
  assert.equal(record.values.goals, 1);
  assert.equal(record.values.assists, 0);
  assert.equal(record.values.minutes, undefined);
  assert.ok(record.missingFields.includes('minutes'));
  assert.equal(fragment.gaResultsAdd[0].contribution, '1G');
  assert.equal(fragment.gaResultsAdd[0].result, 'W');
});

test('final fixture events can establish explicit zero while unsupported fields remain missing', () => {
  const fixture = baseFixture({
    goals: { home: 0, away: 0 },
    events: [],
    lineups: [{
      team: { id: 200, name: 'SC Freiburg' },
      startXI: [{ player: { id: 110, name: 'Tracked Keeper', pos: 'G' } }],
      substitutes: [],
    }],
    players: [{
      team: { id: 200, name: 'SC Freiburg' },
      players: [{
        player: { id: 110, name: 'Tracked Keeper' },
        statistics: [{
          games: { minutes: 90, position: 'G', substitute: false },
          goals: { total: 0, conceded: 0, assists: null, saves: 3 },
          passes: { total: 30, key: 0, accuracy: 25 },
          cards: { yellow: 0, red: 0 },
          penalty: { saved: 0, commited: 0 },
        }],
      }],
    }],
  });

  const fragment = mapFixtureToSchemaV2(fixture, {
    trackedPlayers: [{
      playerId: 'jp-keeper',
      name: '追跡GK',
      apiFootballPlayerId: 110,
      pos: 'GK',
    }],
  });
  const record = fragment.playerMatchStats[0];

  assert.equal(record.values.goals, 0);
  assert.equal(record.values.assists, 0);
  assert.equal(record.values.cleanSheets, 1);
  assert.equal(record.values.saves, 3);
  assert.equal(record.values.shotsOnTargetFaced, 3);
  assert.equal(record.values.passesCompleted, 25);
  assert.equal(record.values.passesAttempted, 30);
  assert.equal(record.values.highClaims, undefined);
  assert.ok(record.missingFields.includes('highClaims'));
});

test('positive player-stat G/A is retained when an embedded event lacks attribution', () => {
  const fixture = baseFixture({
    events: [],
    players: [{
      team: { id: 200, name: 'SC Freiburg' },
      players: [{
        player: { id: 100, name: 'Keisuke Goto' },
        statistics: [{
          games: { minutes: 10, position: 'F', substitute: true },
          goals: { total: 1, assists: 1 },
        }],
      }],
    }],
  });

  const fragment = mapFixtureToSchemaV2(fixture, { trackedPlayers: gotoRegistry });
  const record = fragment.playerMatchStats[0];
  assert.equal(record.values.goals, 1);
  assert.equal(record.values.assists, 1);
  assert.equal(record.appearance, true);
  assert.equal(record.start, false);
  assert.equal(record.bench, true);
  assert.equal(fragment.gaResultsAdd[0].contribution, '1G1A');
  assert.equal(record.ratingConflicts, undefined);
});

test('both teams formation, grid, substitutions and provider ratings are preserved', () => {
  const fixture = baseFixture({
    events: [{
      time: { elapsed: 63, extra: 2 },
      team: { id: 200, name: 'SC Freiburg' },
      player: { id: 100, name: 'Keisuke Goto' },
      assist: { id: 101, name: 'Away replacement' },
      type: 'subst',
      detail: 'Substitution 1',
    }],
    lineups: [{
      team: { id: 300, name: 'Motherwell' },
      coach: { id: 401, name: 'Home Coach', photo: null },
      formation: '4-3-3',
      startXI: [{ player: { id: 301, name: 'Home starter', number: 1, pos: 'G', grid: '1:1' } }],
      substitutes: [{ player: { id: 302, name: 'Home substitute', number: 12, pos: 'G', grid: null } }],
    }, {
      team: { id: 200, name: 'SC Freiburg' },
      coach: { id: 402, name: 'Away Coach', photo: 'https://cdn.example.test/coaches/402.png' },
      formation: '4-2-3-1',
      startXI: [{ player: { id: 100, name: 'Keisuke Goto', number: 9, pos: 'F', grid: '4:1' } }],
      substitutes: [{ player: { id: 101, name: 'Away replacement', number: 19, pos: 'F', grid: null } }],
    }],
    players: [{
      team: { id: 300, name: 'Motherwell' },
      players: [{
        player: { id: 301, name: 'Home starter', photo: 'https://cdn.example.test/players/301.png' },
        statistics: [{ games: { minutes: 90, position: 'G', substitute: false, rating: '6.8' } }],
      }],
    }, {
      team: { id: 200, name: 'SC Freiburg' },
      players: [{
        player: { id: 100, name: 'Keisuke Goto' },
        statistics: [{
          games: { minutes: 63, position: 'F', substitute: false, rating: '7.6' },
          goals: { total: 0, assists: 0 },
        }],
      }, {
        player: { id: 101, name: 'Away replacement' },
        statistics: [{ games: { minutes: 27, position: 'F', substitute: true, rating: '6.9' } }],
      }],
    }],
  });

  const fragment = mapFixtureToSchemaV2(fixture, {
    trackedPlayers: gotoRegistry,
    clubNamesByProviderId: { 200: 'フライブルク', 300: 'マザーウェル' },
  });
  const formationData = fragment.matchUpdates[0].formationData;

  assert.equal(formationData.provider, 'api-football');
  assert.equal(formationData.teams.length, 2);
  const home = formationData.teams.find(team => team.side === 'home');
  const away = formationData.teams.find(team => team.side === 'away');
  assert.equal(home.teamName, 'マザーウェル');
  assert.equal(home.formation, '4-3-3');
  assert.equal(home.startXI[0].apiFootballRating, 6.8);
  assert.equal(home.startXI[0].photo, 'https://cdn.example.test/players/301.png');
  assert.equal(home.startXI[0].playerId, null);
  assert.equal(home.coach.name, 'Home Coach');
  assert.equal(home.coach.photo, 'https://media.api-sports.io/football/coachs/401.png');
  assert.equal(away.teamName, 'フライブルク');
  assert.equal(away.formation, '4-2-3-1');
  assert.equal(away.coach.name, 'Away Coach');
  assert.equal(away.coach.photo, 'https://cdn.example.test/coaches/402.png');
  assert.equal(away.startXI[0].grid, '4:1');
  assert.equal(away.startXI[0].playerId, 'jp-goto-keisuke');
  assert.equal(away.startXI[0].apiFootballRating, 7.6);
  assert.equal(away.startXI[0].photo, 'https://media.api-sports.io/football/players/100.png');
  assert.deepEqual(away.startXI[0].substitution, {
    direction: 'out', elapsed: 63, extra: 2,
    replacementProviderPlayerId: 101, replacementName: 'Away replacement',
  });
  assert.equal(away.substitutes[0].substitution.direction, 'in');
  assert.equal(away.substitutes[0].substitution.replacedName, 'Keisuke Goto');

  const record = fragment.playerMatchStats[0];
  assert.equal(record.providerRatings.apiFootball.value, 7.6);
  assert.equal(record.photo, 'https://media.api-sports.io/football/players/100.png');
  assert.equal(fragment.playerUpdates[0].photo, record.photo);
  assert.equal(record.lineup.grid, '4:1');
  assert.equal(record.substitution.direction, 'out');
});

test('official media templates are deterministic and unsafe image schemes are rejected', () => {
  assert.equal(apiFootballMediaUrl('player', 55), 'https://media.api-sports.io/football/players/55.png');
  assert.equal(apiFootballMediaUrl('coach', 77), 'https://media.api-sports.io/football/coachs/77.png');
  assert.equal(safeImageUrl('https://media.api-sports.io/football/players/55.png'), 'https://media.api-sports.io/football/players/55.png');
  assert.equal(safeImageUrl('javascript:alert(1)'), null);
  assert.equal(safeImageUrl('not a url'), null);
});

test('complete event timeline wins over a conflicting zero player-stat goal', () => {
  const fixture = baseFixture({
    goals: { home: 0, away: 1 },
    events: [{
      team: { id: 200, name: 'SC Freiburg' },
      player: { id: 100, name: 'Keisuke Goto' },
      assist: { id: null, name: null },
      type: 'Goal',
      detail: 'Normal Goal',
    }],
    players: [{
      team: { id: 200, name: 'SC Freiburg' },
      players: [{
        player: { id: 100, name: 'Keisuke Goto' },
        statistics: [{
          games: { minutes: 10, position: 'F', substitute: true },
          goals: { total: 0, assists: 0 },
        }],
      }],
    }],
  });

  const fragment = mapFixtureToSchemaV2(fixture, { trackedPlayers: gotoRegistry });
  const record = fragment.playerMatchStats[0];
  assert.equal(record.values.goals, 1);
  assert.ok(record.ratingConflicts.some(conflict => conflict.field === 'goals'));
});

test('non-final fixture without events does not turn missing goals or assists into zero', () => {
  const fixture = baseFixture({
    fixture: {
      id: 9002,
      date: '2026-08-27T20:30:00+09:00',
      status: { short: 'NS' },
    },
    goals: { home: null, away: null },
    events: undefined,
    lineups: [{
      team: { id: 200, name: 'SC Freiburg' },
      startXI: [],
      substitutes: [{ player: { id: 100, name: 'Keisuke Goto', pos: 'F' } }],
    }],
  });

  const fragment = mapFixtureToSchemaV2(fixture, { trackedPlayers: gotoRegistry });
  const record = fragment.playerMatchStats[0];
  assert.equal(record.appearance, null);
  assert.equal(record.values.goals, undefined);
  assert.equal(record.values.assists, undefined);
  assert.ok(record.missingFields.includes('goals'));
  assert.ok(record.missingFields.includes('assists'));
  assert.equal(fragment.gaResultsAdd.length, 0);
});

test('own-goal event never increments normal goals', () => {
  const fixture = baseFixture({
    goals: { home: 0, away: 1 },
    events: [{
      team: { id: 200, name: 'SC Freiburg' },
      player: { id: 100, name: 'Keisuke Goto' },
      assist: { id: null, name: null },
      type: 'Goal',
      detail: 'Own Goal',
    }],
  });

  const fragment = mapFixtureToSchemaV2(fixture, { trackedPlayers: gotoRegistry });
  const record = fragment.playerMatchStats[0];
  assert.equal(record.values.goals, 0);
  assert.equal(record.values.ownGoals, 1);
  assert.equal(fragment.gaResultsAdd.length, 0);
});

test('tracked registry rejects duplicate provider player ids', () => {
  assert.throws(
    () => normalizeTrackedPlayers([
      { playerId: 'one', name: 'One', apiFootballPlayerId: 7 },
      { playerId: 'two', name: 'Two', apiFootballPlayerId: 7 },
    ]),
    /Duplicate API-Football player id/
  );
});

test('field inventory follows nested array paths without exposing raw fixture data', () => {
  const fixture = baseFixture({
    players: [{
      team: { id: 200 },
      players: [{
        player: { id: 100 },
        statistics: [{ games: { minutes: 10 }, goals: { total: 1 } }],
      }],
    }],
  });
  const map = {
    fieldMappings: {
      minutes: { providerPaths: ['players[].players[].statistics[].games.minutes'] },
      saves: { providerPaths: ['players[].players[].statistics[].goals.saves'] },
    },
  };

  assert.equal(pathPresent(fixture, 'players[].players[].statistics[].games.minutes'), true);
  assert.equal(pathPresent(fixture, 'players[].players[].statistics[].goals.saves'), false);
  const inventory = inventoryFixture(fixture, map);
  assert.equal(inventory.targetsConfigured, 2);
  assert.equal(inventory.targetsObserved, 1);
  assert.equal(inventory.fields.minutes.status, 'present');
  assert.equal(inventory.fields.saves.status, 'not_observed');
});
