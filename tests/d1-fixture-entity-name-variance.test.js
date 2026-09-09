'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeFixtureBundle } = require('../scripts/v2/fixture-contract');
const {
  reconcileMissingPlayerPositions,
  reconcileMissingProviderPlayerIdentities,
  reconcileReviewedPlayerAliases,
  validateBundle,
} = require('../scripts/d1/fixture-bundle-importer');
const reviewedEvidence = require('../config/d1-major-league-snapshot-20260908.json');

function catalog() {
  return {
    productSeasonId: 'jfw:season:2026-27',
    source: { apiVersion: 'v3' },
    competition: { type: 'League' },
    season: { status: 'current' },
    players: [],
  };
}

function hincapieBundle() {
  return normalizeFixtureBundle({
    fixture: {
      id: 1557377,
      date: '2026-09-01T18:00:00+00:00',
      referee: null,
      venue: { id: 10, name: 'Example Stadium', city: 'London' },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
    },
    league: {
      id: 39,
      name: 'Premier League',
      country: 'England',
      season: 2026,
      round: 'Regular Season - 1',
    },
    teams: {
      home: { id: 42, name: 'Home FC', winner: true },
      away: { id: 50, name: 'Away FC', winner: false },
    },
    goals: { home: 2, away: 0 },
    score: {
      halftime: { home: 1, away: 0 },
      fulltime: { home: 2, away: 0 },
      extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
    events: [],
    statistics: [],
    lineups: [{
      team: { id: 42, name: 'Home FC' },
      formation: '4-3-3',
      coach: null,
      startXI: [{ player: { id: 127817, name: 'P. Hincapie', number: 5, pos: 'D', grid: '2:1' } }],
      substitutes: [],
    }],
    players: [{
      team: { id: 42, name: 'Home FC' },
      players: [{
        player: { id: 127817, name: 'Piero Hincapié', photo: 'https://media.api-sports.io/football/players/127817.png' },
        statistics: [{ games: { minutes: 90, position: 'D', substitute: false, captain: false } }],
      }],
    }],
  }, { fetchedAt: '2026-09-08T02:15:09.068Z', revision: 1 });
}

function metcalfeBundle(fetchedAt = '2026-09-08T02:15:09.068Z') {
  return normalizeFixtureBundle({
    fixture: {
      id: 1563085,
      date: '2026-09-01T18:00:00+00:00',
      referee: null,
      venue: { id: 10, name: 'Example Stadium', city: 'Bristol' },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
    },
    league: {
      id: 40,
      name: 'Championship',
      country: 'England',
      season: 2026,
      round: 'Regular Season - 1',
    },
    teams: {
      home: { id: 57, name: 'Bristol City', winner: false },
      away: { id: 58, name: 'Millwall', winner: true },
    },
    goals: { home: 0, away: 1 },
    score: {
      halftime: { home: 0, away: 0 },
      fulltime: { home: 0, away: 1 },
      extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
    events: [
      {
        time: { elapsed: 32, extra: null },
        team: { id: 58, name: 'Millwall' },
        player: { id: 531386, name: 'J. Metcalfe' },
        assist: { id: 297641, name: 'Jenson Metcalfe' },
        type: 'Goal', detail: 'Normal Goal', comments: null,
      },
      {
        time: { elapsed: 64, extra: null },
        team: { id: 58, name: 'Millwall' },
        player: { id: 531386, name: 'J. Metcalfe' },
        assist: null,
        type: 'subst', detail: 'Substitution 1', comments: null,
      },
    ],
    statistics: [],
    lineups: [{
      team: { id: 58, name: 'Millwall' },
      formation: '4-2-3-1',
      coach: null,
      startXI: [{ player: { id: 531386, name: 'J. Metcalfe', number: 10, pos: null, grid: '3:2' } }],
      substitutes: [],
    }],
    players: [{
      team: { id: 58, name: 'Millwall' },
      players: [{
        player: { id: 297641, name: 'Jenson Metcalfe', photo: 'https://media.api-sports.io/football/players/297641.png' },
        statistics: [{ games: { minutes: 64, position: 'M', substitute: false, captain: false } }],
      }],
    }],
  }, { fetchedAt, revision: 1 });
}

function campbellBundle() {
  const bundle = metcalfeBundle();
  bundle.fixture.id = 'af:fixture:1563086';
  bundle.fixture.providerId = 1563086;
  bundle.fixture.teams.home = {
    id: 'af:team:1335', providerId: 1335, name: 'Charlton', logo: null, winner: true,
  };
  bundle.lineups[0].teamId = 'af:team:1335';
  bundle.lineups[0].startXI[0] = {
    id: 'af:player:356419', providerId: 356419, name: 'T. Campbell',
    number: 7, position: null, grid: '4:3', role: 'starter',
  };
  bundle.playerStats[0] = {
    ...bundle.playerStats[0],
    fixtureId: 'af:fixture:1563086',
    playerId: 'af:player:394294',
    playerProviderId: 394294,
    playerName: 'Tyreece Campbell',
    teamId: 'af:team:1335',
    position: 'M',
    starter: true,
    values: { minutes: 90, rating: 7.9, goals: 1 },
  };
  bundle.events = [{
    ...bundle.events[0],
    id: 'af:event:1563086:7',
    teamId: 'af:team:1335',
    playerId: 'af:player:356419',
    relatedPlayerId: null,
    elapsed: 80,
  }];
  return bundle;
}

function morganBundle() {
  const bundle = metcalfeBundle();
  bundle.fixture.id = 'af:fixture:1563088';
  bundle.fixture.providerId = 1563088;
  bundle.fixture.teams.away = {
    id: 'af:team:60', providerId: 60, name: 'West Brom', logo: null, winner: true,
  };
  bundle.lineups[0].teamId = 'af:team:60';
  bundle.lineups[0].startXI[0] = {
    id: 'af:player:544659', providerId: 544659, name: 'J. Morgan',
    number: 11, position: null, grid: '4:1', role: 'starter',
  };
  bundle.playerStats[0] = {
    ...bundle.playerStats[0],
    fixtureId: 'af:fixture:1563088',
    playerId: 'af:player:330982',
    playerProviderId: 330982,
    playerName: 'Jimmy Morgan',
    teamId: 'af:team:60',
    position: 'F',
    starter: true,
    values: { minutes: 89, rating: 8, goals: 1, assists: 1 },
  };
  bundle.events = [{
    ...bundle.events[0],
    id: 'af:event:1563088:10',
    teamId: 'af:team:60',
    playerId: 'af:player:544659',
    relatedPlayerId: null,
    elapsed: 87,
  }];
  return bundle;
}

function lawalBundle() {
  const bundle = metcalfeBundle();
  bundle.fixture.id = 'af:fixture:1563090';
  bundle.fixture.providerId = 1563090;
  bundle.fixture.teams.away = {
    id: 'af:team:75', providerId: 75, name: 'Stoke City', logo: null, winner: false,
  };
  bundle.lineups[0].teamId = 'af:team:75';
  bundle.lineups[0].startXI[0] = {
    id: 'af:player:425199', providerId: 425199, name: 'B. Lawal',
    number: 18, position: null, grid: '3:2', role: 'starter',
  };
  bundle.playerStats[0] = {
    ...bundle.playerStats[0], fixtureId: 'af:fixture:1563090',
    playerId: 'af:player:309814', playerProviderId: 309814,
    playerName: 'Bosun Lawal', teamId: 'af:team:75', position: 'M', starter: true,
  };
  bundle.events = [{
    ...bundle.events[0], id: 'af:event:1563090:2', teamId: 'af:team:75',
    playerId: 'af:player:425199', relatedPlayerId: null,
  }];
  return bundle;
}

function ouziadBundle() {
  const bundle = metcalfeBundle();
  bundle.fixture.id = 'af:fixture:1552730';
  bundle.fixture.providerId = 1552730;
  bundle.fixture.competitionId = 'af:competition:61';
  bundle.fixture.seasonId = 'af:season:61:2026';
  bundle.fixture.teams.away = {
    id: 'af:team:111', providerId: 111, name: 'Le Havre', logo: null, winner: false,
  };
  bundle.lineups[0].teamId = 'af:team:111';
  bundle.lineups[0].startXI[0] = {
    id: 'af:player:673857', providerId: 673857, name: 'D. Ouziad',
    number: 35, position: null, grid: null, role: 'substitute',
  };
  bundle.playerStats[0] = {
    ...bundle.playerStats[0], fixtureId: 'af:fixture:1552730',
    playerId: 'af:player:957', playerProviderId: 957,
    playerName: 'Djibril Ouziad', teamId: 'af:team:111', position: 'M', starter: false,
  };
  bundle.events[0] = {
    ...bundle.events[0], id: 'af:event:1552730:4', teamId: 'af:team:111',
    playerId: 'af:player:957', relatedPlayerId: null,
  };
  return bundle;
}

function nkengBundle() {
  const bundle = metcalfeBundle();
  bundle.fixture.id = 'af:fixture:1563130';
  bundle.fixture.providerId = 1563130;
  bundle.lineups[0].teamId = 'af:team:1335';
  bundle.lineups[0].substitutes = [{
    id: 'af:player:584930', providerId: 584930, name: 'R. Nkeng',
    number: 35, position: null, grid: null, role: 'substitute',
  }];
  bundle.lineups[0].startXI = [];
  bundle.playerStats = [{
    ...bundle.playerStats[0], fixtureId: 'af:fixture:1563130',
    playerId: 'af:player:615628', playerProviderId: 615628,
    playerName: 'Junior Nkeng', teamId: 'af:team:1335', position: 'F', starter: false,
  }];
  bundle.events = [];
  return bundle;
}

test('accepts provider display-name variants for the same canonical player identity', () => {
  const context = validateBundle(hincapieBundle(), catalog());
  const player = context.players.get('af:player:127817');
  assert.equal(player.providerId, 127817);
  assert.equal(player.name, 'Piero Hincapié');
});

test('still fails closed when canonical player id and provider id disagree', () => {
  const bundle = hincapieBundle();
  bundle.playerStats[0].playerProviderId = 127818;
  assert.throws(
    () => validateBundle(bundle, catalog()),
    /playerStats\[0\]\.id must equal af:player:127818/,
  );
});

test('omits nullable provider team-stat values before D1 validation', () => {
  const bundle = hincapieBundle();
  bundle.teamStats = [{
    teamId: 'af:team:42',
    values: { red_cards: null, total_shots: 10 },
    provenance: bundle.fixture.provenance,
  }];
  const context = validateBundle(bundle, catalog());
  assert.deepEqual(context.normalized.teamStats[0].values, { total_shots: 10 });
});

test('applies the reviewed Millwall player alias across lineup and event references', () => {
  const result = reconcileReviewedPlayerAliases(metcalfeBundle());
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].snapshotId, '20260908-021509068Z');
  assert.equal(result.applications[0].aliasPlayerId, 'af:player:531386');
  assert.equal(result.applications[0].canonicalPlayerId, 'af:player:297641');
  assert.equal(result.bundle.lineups[0].startXI[0].id, 'af:player:297641');
  assert.equal(result.bundle.lineups[0].startXI[0].providerId, 297641);
  assert.equal(result.bundle.events[0].playerId, 'af:player:297641');
  assert.equal(result.bundle.events[0].relatedPlayerId, 'af:player:297641');
  assert.equal(result.bundle.events[1].playerId, 'af:player:297641');

  const context = validateBundle(metcalfeBundle(), catalog());
  assert.equal(context.players.has('af:player:531386'), false);
  assert.equal(context.players.get('af:player:297641').name, 'Jenson Metcalfe');
  assert.equal(context.normalized.lineups[0].startXI[0].position, 'M');
  assert.equal(context.normalized.playerStats[0].position, 'M');
  assert.equal(context.providerVariantEvidence.playerAliases.length, 1);
});

test('reconciles Tyreece Campbell lineup and goal references with his player statistics identity', () => {
  const result = reconcileReviewedPlayerAliases(campbellBundle());
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].aliasPlayerId, 'af:player:356419');
  assert.equal(result.applications[0].canonicalPlayerId, 'af:player:394294');
  assert.equal(result.bundle.lineups[0].startXI[0].id, 'af:player:394294');
  assert.equal(result.bundle.lineups[0].startXI[0].providerId, 394294);
  assert.equal(result.bundle.events[0].playerId, 'af:player:394294');

  const context = validateBundle(campbellBundle(), catalog());
  assert.equal(context.players.has('af:player:356419'), false);
  assert.equal(context.players.get('af:player:394294').name, 'Tyreece Campbell');
  assert.equal(context.normalized.lineups[0].startXI[0].position, 'M');
  assert.equal(context.providerVariantEvidence.playerAliases.length, 1);
});

test('reconciles Jimmy Morgan lineup and goal references with his player statistics identity', () => {
  const result = reconcileReviewedPlayerAliases(morganBundle());
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0].aliasPlayerId, 'af:player:544659');
  assert.equal(result.applications[0].canonicalPlayerId, 'af:player:330982');
  assert.equal(result.bundle.lineups[0].startXI[0].id, 'af:player:330982');
  assert.equal(result.bundle.lineups[0].startXI[0].providerId, 330982);
  assert.equal(result.bundle.events[0].playerId, 'af:player:330982');

  const context = validateBundle(morganBundle(), catalog());
  assert.equal(context.players.has('af:player:544659'), false);
  assert.equal(context.players.get('af:player:330982').name, 'Jimmy Morgan');
  assert.equal(context.normalized.lineups[0].startXI[0].position, 'F');
  assert.equal(context.providerVariantEvidence.playerAliases.length, 1);
});

test('loads every corroborated positive-id variance as pinned reviewed evidence', () => {
  assert.equal(reviewedEvidence.playerIdentityVarianceReview.reviewedPairCount, 78);
  assert.equal(reviewedEvidence.playerIdentityVarianceReview.newlyReviewedPairCount, 75);
  assert.equal(reviewedEvidence.playerIdentityVarianceReview.reversedToLineupIdentityCount, 4);
  assert.equal(reviewedEvidence.playerIdentityVarianceReview.nonLexicalCorroboratedPairCount, 5);
  assert.equal(reviewedEvidence.playerIdentityVarianceReview.excludedMissingOrZeroIdPairCount, 8);
  assert.equal(reviewedEvidence.playerAliases.length, 78);
});

test('quarantines missing and zero player identities without merging distinct people', () => {
  const bundle = hincapieBundle();
  bundle.lineups[0].substitutes.push({
    id: null, providerId: null, name: 'Lineup Without ID', number: 20,
    position: 'M', grid: null, role: 'substitute',
  });
  for (const name of ['First Zero ID', 'Second Zero ID']) {
    bundle.playerStats.push({
      ...structuredClone(bundle.playerStats[0]),
      playerId: 'af:player:0', playerProviderId: 0, playerName: name,
      position: null, starter: true, values: { minutes: 0 },
    });
  }
  bundle.events.push({
    id: 'af:event:1557377:99', type: 'card', detail: 'Yellow Card', comments: null,
    elapsed: 90, extra: null, teamId: 'af:team:42', playerId: 'af:player:0',
    relatedPlayerId: null, provenance: bundle.fixture.provenance,
  });

  const reconciled = reconcileMissingProviderPlayerIdentities(bundle);
  assert.equal(reconciled.bundle.lineups[0].substitutes.length, 0);
  assert.equal(reconciled.bundle.playerStats.length, 1);
  assert.equal(reconciled.bundle.events.at(-1).playerId, null);
  assert.deepEqual(reconciled.omissions.map(item => item.name).sort(),
    ['First Zero ID', 'Lineup Without ID', 'Second Zero ID']);

  const context = validateBundle(bundle, catalog());
  assert.equal(context.players.has('af:player:0'), false);
  assert.equal(context.providerVariantEvidence.playerIdentityOmissions.length, 3);
});

test('reconciles the next blocking Bosun Lawal variance to the player-statistics identity', () => {
  const result = reconcileReviewedPlayerAliases(lawalBundle());
  assert.equal(result.applications.length, 1);
  assert.equal(result.bundle.lineups[0].startXI[0].id, 'af:player:309814');
  assert.equal(result.bundle.playerStats[0].playerId, 'af:player:309814');
  assert.equal(result.bundle.events[0].playerId, 'af:player:309814');
});

test('reverses a fixture-player id that conflicts with the saved season identity', () => {
  const result = reconcileReviewedPlayerAliases(ouziadBundle());
  assert.equal(result.applications.length, 1);
  assert.equal(result.bundle.lineups[0].startXI[0].id, 'af:player:673857');
  assert.equal(result.bundle.playerStats[0].playerId, 'af:player:673857');
  assert.equal(result.bundle.playerStats[0].playerProviderId, 673857);
  assert.equal(result.bundle.events[0].playerId, 'af:player:673857');
});

test('reconciles a reviewed full-name and nickname-initial variance', () => {
  const result = reconcileReviewedPlayerAliases(nkengBundle());
  assert.equal(result.applications.length, 1);
  assert.equal(result.bundle.lineups[0].substitutes[0].id, 'af:player:615628');
  assert.equal(result.bundle.playerStats[0].playerId, 'af:player:615628');
});

test('fills a missing lineup position from matching player stats', () => {
  const bundle = hincapieBundle();
  bundle.lineups[0].startXI[0].position = null;
  const reconciled = reconcileMissingPlayerPositions(bundle);
  assert.equal(reconciled.lineups[0].startXI[0].position, 'D');
  assert.equal(reconciled.playerStats[0].position, 'D');
  const context = validateBundle(bundle, catalog());
  assert.equal(context.normalized.lineups[0].startXI[0].position, 'D');
});

test('fills a missing player-stats position from the matching lineup', () => {
  const bundle = hincapieBundle();
  bundle.playerStats[0].position = null;
  const reconciled = reconcileMissingPlayerPositions(bundle);
  assert.equal(reconciled.lineups[0].startXI[0].position, 'D');
  assert.equal(reconciled.playerStats[0].position, 'D');
  const context = validateBundle(bundle, catalog());
  assert.equal(context.normalized.playerStats[0].position, 'D');
});

test('still fails closed when lineup and player stats provide conflicting positions', () => {
  const bundle = hincapieBundle();
  bundle.playerStats[0].position = 'M';
  assert.throws(
    () => validateBundle(bundle, catalog()),
    /playerStats\[0\] conflicts with lineup team or position/,
  );
});

test('does not apply the reviewed alias outside the pinned snapshot observation', () => {
  const result = reconcileReviewedPlayerAliases(metcalfeBundle('2026-09-08T02:15:09.069Z'));
  assert.equal(result.applications.length, 0);
  assert.equal(result.bundle.lineups[0].startXI[0].id, 'af:player:531386');
  assert.equal(result.bundle.playerStats[0].playerId, 'af:player:297641');
});

test('fails closed when a reviewed alias canonical id and provider id disagree', () => {
  const bundle = metcalfeBundle();
  bundle.lineups[0].startXI[0].providerId = 999999;
  assert.throws(
    () => reconcileReviewedPlayerAliases(bundle),
    /reviewed player alias identity mismatch/,
  );
});
