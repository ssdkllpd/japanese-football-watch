'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeFixtureBundle } = require('../scripts/v2/fixture-contract');
const {
  reconcileReviewedPlayerAliases,
  validateBundle,
} = require('../scripts/d1/fixture-bundle-importer');

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
      startXI: [{ player: { id: 531386, name: 'J. Metcalfe', number: 10, pos: 'M', grid: '3:2' } }],
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
  assert.equal(context.providerVariantEvidence.playerAliases.length, 1);
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
