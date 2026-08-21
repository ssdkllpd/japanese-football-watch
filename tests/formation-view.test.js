const test = require('node:test');
const assert = require('node:assert/strict');
const formation = require('../formation-view');

test('API-Football grid values become stable pitch coordinates', () => {
  const players = formation.layoutPlayers([
    { name: 'GK', position: 'GK', grid: '1:1' },
    { name: 'Left back', position: 'DF', grid: '2:1' },
    { name: 'Right back', position: 'DF', grid: '2:2' },
    { name: 'Midfielder', position: 'MF', grid: '3:1' },
    { name: 'Forward', position: 'FW', grid: '4:1' },
  ]);

  const byName = Object.fromEntries(players.map(player => [player.name, player]));
  assert.ok(byName.GK.y > byName['Left back'].y);
  assert.ok(byName['Left back'].y > byName.Midfielder.y);
  assert.ok(byName.Midfielder.y > byName.Forward.y);
  assert.ok(byName['Left back'].x < byName['Right back'].x);
  for (const player of players) {
    assert.ok(player.x >= 7 && player.x <= 93);
    assert.ok(player.y >= 8 && player.y <= 91);
  }
});

test('formation rating switches by stable player identity and preserves missing as null', () => {
  const player = { providerPlayerId: 10, apiFootballRating: '7.4' };
  const records = [{
    playerId: 'jp-player-10',
    providerIds: { apiFootball: { player: 10 } },
    jfwRating: 8.1,
  }];

  assert.equal(formation.ratingForPlayer(player, 'apiFootball', records), 7.4);
  assert.equal(formation.ratingForPlayer(player, 'jfw', records), 8.1);
  assert.equal(formation.ratingForPlayer({ providerPlayerId: 11 }, 'apiFootball', records), null);
  assert.equal(formation.ratingForPlayer({ providerPlayerId: 11 }, 'jfw', records), null);
  assert.equal(formation.recordForPlayer({ name: 'same display name' }, [{ playerName: 'same display name' }]), null);
});

test('substitution minute includes stoppage time when supplied', () => {
  assert.equal(formation.formatMinute({ elapsed: 63, extra: 2 }), '63+2′');
  assert.equal(formation.formatMinute({ elapsed: 78, extra: null }), '78′');
  assert.equal(formation.formatMinute({ elapsed: null }), '時刻未取得');
});
