'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeFixtureBundle } = require('../scripts/v2/fixture-contract');
const { validateBundle } = require('../scripts/d1/fixture-bundle-importer');

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
