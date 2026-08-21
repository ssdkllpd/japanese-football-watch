const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBackfillHarness } = require('./helpers/backfill-harness');

function buildHarness({ player, fragments }) {
  return buildBackfillHarness({
    data: {
      updated: '2026-08-10 10:00 JST',
      players: [player],
      matches: [],
      topMatches: [],
      playerMatchStats: [],
      gaResults: []
    },
    season: '2026-27',
    fragments,
    order: ['すべて', 'プレミアリーグ', 'ブンデスリーガ']
  });
}

async function apply(context) {
  await context.window.JFWBackfill.initialLoad;
  return context.D.players[0];
}

test('tracked-to-tracked transfer keeps one player and splits club stats while preserving season total', async () => {
  const player = {
    name: '移籍太郎',
    club: 'Club A',
    league: 'プレミアリーグ',
    stats: { apps: 2, starts: 2, minutes: 180, goals: 2, assists: 1 }
  };
  const fragments = [
    {
      updated: '2026-08-20 12:00 JST',
      playerUpdates: [{
        name: '移籍太郎',
        club: 'Club B',
        league: 'ブンデスリーガ',
        membershipChangeType: 'transfer',
        transferDate: '2026-08-15'
      }],
      matchUpdates: [{ matchId: 'b-1', league: 'ブンデスリーガ', ko: '2026-08-18 20:00', match: 'Club B 1-0 X', addIfMissing: true }],
      playerMatchStats: [{
        recordId: 'b-1-p', matchId: 'b-1', player: '移籍太郎', club: 'Club B', league: 'ブンデスリーガ', appearance: true, start: true,
        values: { minutes: 90, goals: 1, assists: 0 }, missingFields: []
      }]
    }
  ];
  const context = buildHarness({ player, fragments });
  const p = await apply(context);

  assert.equal(context.D.players.length, 1);
  assert.match(p.playerId, /^jp-/);
  assert.equal(p.membershipHistory.length, 2);
  assert.equal(p.membershipHistory[0].club, 'Club A');
  assert.equal(p.membershipHistory[0].to, '2026-08-15');
  assert.equal(p.membershipHistory[1].club, 'Club B');
  assert.equal(p.trackingStatus, 'active');
  assert.equal(p.seasonStats.goals, 3);
  assert.equal(p.clubStats['Club A'].goals, 2);
  assert.equal(p.clubStats['Club B'].goals, 1);
  assert.equal(p.competitionStats['プレミアリーグ'].goals, 2);
  assert.equal(p.competitionStats['ブンデスリーガ'].goals, 1);
});

test('tracked-to-out-of-scope transfer retains player and ranking with frozen tracked stats', async () => {
  const player = {
    name: '海外次郎',
    club: 'Club A',
    league: 'プレミアリーグ',
    stats: { apps: 3, starts: 2, minutes: 220, goals: 2, assists: 1 }
  };
  const fragments = [{
    updated: '2026-08-20 12:00 JST',
    playerUpdates: [{
      name: '海外次郎',
      club: 'Jクラブ',
      league: 'J1',
      membershipChangeType: 'transfer',
      transferDate: '2026-08-16'
    }]
  }];
  const context = buildHarness({ player, fragments });
  const p = await apply(context);

  assert.equal(context.D.players.length, 1);
  assert.equal(p.club, 'Jクラブ');
  assert.equal(p.previousClub, 'Club A');
  assert.equal(p.trackingStatus, 'out_of_scope');
  assert.equal(p.trackingBucket, '無所属・追跡対象外');
  assert.equal(p.rankingEligible, true);
  assert.equal(p.statsTrackingState, 'frozen_out_of_scope');
  assert.equal(p.seasonStats.goals, 2);
  assert.equal(p.clubStats['Club A'].goals, 2);
  assert.equal(p.clubStats['Jクラブ'], undefined);
});

test('membership correction fixes current club without inventing a transfer stint', async () => {
  const player = {
    name: '訂正三郎',
    club: 'Wrong Club',
    league: 'プレミアリーグ',
    stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 }
  };
  const fragments = [{
    updated: '2026-08-20 12:00 JST',
    playerUpdates: [{
      name: '訂正三郎',
      club: 'Correct Club',
      league: 'プレミアリーグ',
      membershipChangeType: 'correction'
    }]
  }];
  const context = buildHarness({ player, fragments });
  const p = await apply(context);

  assert.equal(p.club, 'Correct Club');
  assert.equal(p.membershipHistory.length, 1);
  assert.equal(p.membershipHistory[0].club, 'Correct Club');
  assert.equal(p.membershipCorrections.length, 1);
  assert.equal(p.membershipCorrections[0].fromClub, 'Wrong Club');
});

test('provider id updates merge without deleting ids from another provider', async () => {
  const player = {
    playerId: 'jp-provider-player',
    name: '識別四郎',
    club: 'Club A',
    league: 'プレミアリーグ',
    providerIds: {
      manualSource: { player: 'manual-44' },
      apiFootball: { team: 10 }
    },
    stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 }
  };
  const fragments = [{
    updated: '2026-08-21 14:00 JST',
    playerUpdates: [{
      playerId: 'jp-provider-player',
      name: '識別四郎',
      providerIds: {
        apiFootball: { player: 1234 }
      }
    }]
  }];
  const context = buildHarness({ player, fragments });
  const p = await apply(context);

  assert.equal(p.providerIds.manualSource.player, 'manual-44');
  assert.equal(p.providerIds.apiFootball.team, 10);
  assert.equal(p.providerIds.apiFootball.player, 1234);
});

test('formation data and provider rating survive the runtime backfill merge', async () => {
  const player = {
    playerId: 'jp-formation-player',
    name: '配置五郎',
    club: 'Club A',
    league: 'プレミアリーグ',
    providerIds: { apiFootball: { player: 55 } },
    stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 }
  };
  const formationData = {
    version: '1.0',
    provider: 'api-football',
    teams: [{
      side: 'home', teamId: 5, teamName: 'Club A', formation: '4-3-3',
      startXI: [{ providerPlayerId: 55, playerId: 'jp-formation-player', name: '配置五郎', grid: '3:2', apiFootballRating: 7.2 }],
      substitutes: []
    }]
  };
  const fragments = [{
    updated: '2026-08-21 15:00 JST',
    sources: { apiFixture: { id: 'apiFixture', name: 'API-Football fixture bundle' } },
    playerUpdates: [{
      playerId: 'jp-formation-player', name: '配置五郎',
      photo: 'https://media.api-sports.io/football/players/55.png',
      photoSource: 'api_football_media_template'
    }],
    matchUpdates: [{
      matchId: 'formation-match', league: 'プレミアリーグ', ko: '2026-08-21 20:00',
      match: 'Club A 1-0 Club B', addIfMissing: true, formationData
    }],
    playerMatchStats: [{
      recordId: 'formation-match-player', matchId: 'formation-match', playerId: 'jp-formation-player',
      playerName: '配置五郎', club: 'Club A', competition: 'プレミアリーグ', appearance: true, start: true,
      values: { minutes: 90, goals: 0, assists: 0 }, missingFields: [], sourceIds: ['apiFixture'],
      photo: 'https://media.api-sports.io/football/players/55.png',
      providerIds: { apiFootball: { player: 55, fixture: 500 } },
      providerRatings: { apiFootball: { value: 7.2, sourceId: 'apiFixture' } },
      lineup: { role: 'starter', number: 8, position: 'MF', grid: '3:2' },
      substitution: { direction: 'out', elapsed: 82, extra: null, replacementProviderPlayerId: 66 }
    }]
  }];
  const context = buildHarness({ player, fragments });
  await apply(context);

  assert.deepEqual(JSON.parse(JSON.stringify(context.D.matches[0].formationData)), formationData);
  assert.equal(context.D.players[0].photo, 'https://media.api-sports.io/football/players/55.png');
  const record = context.D.playerMatchStats[0];
  assert.equal(record.photo, context.D.players[0].photo);
  assert.equal(record.providerRatings.apiFootball.value, 7.2);
  assert.equal(record.lineup.grid, '3:2');
  assert.equal(record.substitution.direction, 'out');
  assert.equal(record.ratingInputs.minutes.value, 90);
});

test('a later provider fragment enriches rating inputs without erasing earlier known values', async () => {
  const player = {
    playerId: 'jp-rating-player',
    name: '採点六郎',
    club: 'Club A',
    league: 'プレミアリーグ',
    stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 }
  };
  const matchUpdate = {
    matchId: 'rating-match', league: 'プレミアリーグ', ko: '2026-08-21 20:00',
    match: 'Club A 1-0 Club B', addIfMissing: true
  };
  const fragments = [{
    updated: '2026-08-21 14:00 JST',
    matchUpdates: [matchUpdate],
    playerMatchStats: [{
      recordId: 'manual-rating-record', matchId: 'rating-match', playerId: 'jp-rating-player',
      player: '採点六郎', club: 'Club A', league: 'プレミアリーグ', appearance: true, start: true,
      values: { minutes: 90, goals: 0, shotsOnTarget: 0 },
      disciplineClean: true,
      missingFields: ['tackles']
    }]
  }, {
    updated: '2026-08-21 15:00 JST',
    sources: { apiFixture: { id: 'apiFixture', name: 'API-Football fixture bundle' } },
    playerMatchStats: [{
      recordId: 'api-rating-record', matchId: 'rating-match', playerId: 'jp-rating-player',
      player: '採点六郎', club: 'Club A', league: 'プレミアリーグ', appearance: true, start: true,
      values: { minutes: 90, goals: 0, tackles: 4 },
      missingFields: ['shotsOnTarget', 'penaltiesConceded'],
      providerIds: { apiFootball: { player: 60, fixture: 600 } },
      providerRatings: { apiFootball: { value: 7.1, sourceId: 'apiFixture' } },
      sourceIds: ['apiFixture']
    }]
  }];
  const context = buildHarness({ player, fragments });
  await apply(context);

  const record = context.D.playerMatchStats[0];
  assert.equal(record.ratingInputs.shotsOnTarget.value, 0);
  assert.equal(record.ratingInputs.shotsOnTarget.state, 'value');
  assert.equal(record.ratingInputs.penaltiesConceded.value, 0);
  assert.equal(record.ratingInputs.tackles.value, 4);
  assert.equal(record.providerRatings.apiFootball.value, 7.1);
  assert.equal(record.missingFields.includes('shotsOnTarget'), false);
  assert.equal(record.missingFields.includes('penaltiesConceded'), false);
});
