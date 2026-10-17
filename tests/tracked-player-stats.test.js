'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../tracked-player-stats');

const metric = value => ({ value, presence: 'present' });
function payload(league, rows) {
  return { competition: { id: `af:competition:${league}`, providerId: league },
    playerStats: { presence: 'present', rows } };
}
function row(id, team, goals, assists = 0) {
  return { player: { providerId: id, photo: 'https://example.test/player.png' },
    team: { id: `af:team:${team}` }, appearances: 3, minutes: metric(250),
    goals: metric(goals), assists: metric(assists), redCards: metric(0) };
}

test('explicit player, team and competition evidence links published totals to one tracked profile', () => {
  const players = [{ playerId: 'jp-1', name: '選手', providerIds: { apiFootball: { player: 42 } } }];
  const records = [{ playerId: 'jp-1', providerIds: { apiFootball: { player: 42, team: 50, league: 39 } } }];
  const result = build(players, records, [payload(39, [row(42, 50, 2, 1), row(42, 60, 9), row(43, 50, 8)]), payload(61, [row(42, 50, 7)])]);
  assert.equal(result.get('jp-1').seasonStats.goals, 2);
  assert.equal(result.get('jp-1').seasonStats.apps, 3);
  assert.equal(result.get('jp-1').competitionStats['af:competition:39'].assists, 1);
  assert.equal(result.get('jp-1').clubStats['af:team:50'].goals, 2);
});

test('names do not link people and conflicting explicit provider IDs are rejected', () => {
  const players = [{ playerId: 'jp-a', name: 'Same Name' },
    { playerId: 'jp-b', name: 'Same Name', providerIds: { apiFootball: { player: 42 } } }];
  const records = [{ playerId: 'jp-b', providerIds: { apiFootball: { player: 43, team: 50, league: 39 } } }];
  const result = build(players, records, [payload(39, [row(42, 50, 2)])]);
  assert.equal(result.size, 0);
});

test('missing provider metric stays unknown, even when other matches report zero', () => {
  const players = [{ playerId: 'jp-1', providerIds: { apiFootball: { player: 42 } } }];
  const rows = [row(42, 50, 1), row(42, 50, 0)];
  rows[1].goals = { value: null, presence: 'provider_missing' };
  const result = build(players, [{ playerId: 'jp-1', providerIds: { apiFootball: { team: 50, league: 39 } } }], [payload(39, rows)]);
  assert.equal(result.get('jp-1').seasonStats.goals, null);
  assert.equal(result.get('jp-1').seasonStats.apps, 6);
});

test('a failed or absent league payload does not claim the player has no appearances', () => {
  const player = { playerId: 'jp-1', league: 'Premier League', providerIds: { apiFootball: { player: 42 } } };
  const records = [{ playerId: 'jp-1', providerIds: { apiFootball: { team: 50, league: 39 } } }];
  assert.equal(build([player], records, [payload(61, [])]).size, 0);
  const empty = build([player], records, [payload(39, [])]);
  assert.equal(empty.get('jp-1').seasonStats, null);
});
