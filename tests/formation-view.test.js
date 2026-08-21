const test = require('node:test');
const assert = require('node:assert/strict');
const formation = require('../formation-view');

function playersForFormation(value) {
  const parsed = formation.parseFormation(value);
  assert.ok(parsed, `formation must parse in fixture: ${value}`);
  const rows = [{ name: 'GK', position: 'GK', grid: '1:1' }];
  parsed.counts.forEach((count, lineIndex) => {
    const row = lineIndex + 2;
    const position = lineIndex === 0 ? 'DF' : lineIndex === parsed.counts.length - 1 ? 'FW' : 'MF';
    for (let column = 1; column <= count; column += 1) {
      rows.push({ name: `${value}-${row}-${column}`, position, grid: `${row}:${column}` });
    }
  });
  return rows;
}

test('API-Football grid values become stable pitch coordinates', () => {
  const players = formation.layoutPlayers([
    { name: 'GK', position: 'GK', grid: '1:1' },
    { name: 'Left back', position: 'DF', grid: '2:1' },
    { name: 'Right back', position: 'DF', grid: '2:2' },
    { name: 'Midfielder', position: 'MF', grid: '3:1' },
    { name: 'Forward', position: 'FW', grid: '4:1' },
  ]);

  const byName = Object.fromEntries(players.map(player => [player.name, player]));
  assert.equal(byName.GK.y, formation.BAND_Y.GK);
  assert.equal(byName['Left back'].y, formation.BAND_Y.DEF);
  assert.equal(byName.Midfielder.y, formation.BAND_Y.CM);
  assert.equal(byName.Forward.y, formation.BAND_Y.FW);
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

test('person photo helpers allow web images and produce readable fallbacks', () => {
  assert.equal(formation.safeImageUrl('https://media.api-sports.io/football/players/10.png'), 'https://media.api-sports.io/football/players/10.png');
  assert.equal(formation.safeImageUrl('data:image/png;base64,aaa'), null);
  assert.equal(formation.safeImageUrl('javascript:alert(1)'), null);
  assert.equal(formation.personInitials('Keisuke Goto'), 'KG');
  assert.equal(formation.personInitials('後藤啓介'), '後藤');
});

test('supported formation strings parse into ten outfield slots and semantic bands', () => {
  for (const value of ['4-4-2', '4-2-3-1', '4-3-3', '3-4-2-1', '5-3-2']) {
    const parsed = formation.parseFormation(value);
    assert.ok(parsed, value);
    assert.equal(parsed.counts.reduce((sum, count) => sum + count, 0), 10);
  }
  const plan = formation.formationPlan('4-2-3-1');
  assert.deepEqual(plan.rows.map(row => row.band), ['GK', 'DEF', 'DM', 'AM', 'FW']);
});

test('semantic vertical bands do not move across common formations', () => {
  for (const value of ['4-4-2', '4-2-3-1', '4-3-3', '3-4-2-1', '5-3-2']) {
    const result = formation.layoutFormation(playersForFormation(value), value);
    assert.equal(result.confidence, 'high', value);
    const gk = result.players.filter(player => player.layoutBand === 'GK');
    const defenders = result.players.filter(player => player.layoutBand === 'DEF');
    const forwards = result.players.filter(player => player.layoutBand === 'FW');
    assert.deepEqual([...new Set(gk.map(player => player.y))], [formation.BAND_Y.GK], value);
    assert.deepEqual([...new Set(defenders.map(player => player.y))], [formation.BAND_Y.DEF], value);
    assert.deepEqual([...new Set(forwards.map(player => player.y))], [formation.BAND_Y.FW], value);
  }
});

test('formation slot count keeps an explicit grid column stable for full and partial rendering', () => {
  const full = formation.layoutPlayers(playersForFormation('4-4-2'), '4-4-2');
  const fullTarget = full.find(player => player.grid === '2:3');
  const partial = formation.layoutPlayers([
    { name: 'Only defender', position: 'DF', grid: '2:3' },
    { name: 'Another row', position: 'MF', grid: '3:2' },
  ], '4-4-2');
  const partialTarget = partial.find(player => player.grid === '2:3');
  assert.equal(fullTarget.x, 60);
  assert.equal(partialTarget.x, 60);
});

test('explicit grid columns are reserved before missing-grid players to prevent coordinate collisions', () => {
  const result = formation.layoutPlayers([
    { name: 'Left', position: 'DF', grid: '2:1' },
    { name: 'Right', position: 'DF', grid: '2:4' },
    { name: 'Missing grid', position: 'DF', grid: null },
  ], '4-4-2');
  const coordinates = result.map(player => `${player.x}:${player.y}`);
  assert.equal(new Set(coordinates).size, coordinates.length);
  assert.equal(result.find(player => player.name === 'Right').x, 80);
  assert.equal(result.find(player => player.name === 'Missing grid').x, 40);
});

test('layout confidence follows formation, grid, position, then even fallback chain', () => {
  const high = formation.layoutFormation(playersForFormation('4-3-3'), '4-3-3');
  const medium = formation.layoutFormation(playersForFormation('4-3-3'), 'broken');
  const low = formation.layoutFormation([
    { name: 'GK', position: 'GK' },
    { name: 'DF', position: 'DF' },
    { name: 'MF', position: 'MF' },
    { name: 'FW', position: 'FW' },
  ], null);
  const none = formation.layoutFormation([{ name: 'A' }, { name: 'B' }], null);
  assert.equal(high.confidence, 'high');
  assert.equal(medium.confidence, 'medium');
  assert.equal(low.confidence, 'low');
  assert.equal(none.confidence, 'none');
});

test('malformed formation strings never throw and fall through to lower-confidence layout', () => {
  const malformed = ['', '4', 'abc', '0-4-2', '1-1-1-1-1-5'];
  const players = playersForFormation('4-4-2');
  for (const value of malformed) {
    assert.doesNotThrow(() => formation.layoutFormation(players, value), value);
    assert.notEqual(formation.layoutFormation(players, value).confidence, 'high', value);
  }
});

test('five-player defensive line preserves enough horizontal separation for mobile labels', () => {
  const result = formation.layoutFormation(playersForFormation('5-3-2'), '5-3-2');
  const xs = result.players
    .filter(player => player.layoutBand === 'DEF')
    .map(player => player.x)
    .sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, index) => x - xs[index]);
  assert.equal(xs.length, 5);
  assert.ok(Math.min(...gaps) >= 16.5);
});

test('layoutPlayers one-argument API remains backward compatible and exposes non-enumerable metadata', () => {
  const players = formation.layoutPlayers([
    { name: 'GK', position: 'GK', grid: '1:1' },
    { name: 'DF', position: 'DF', grid: '2:1' },
    { name: 'MF', position: 'MF', grid: '3:1' },
    { name: 'FW', position: 'FW', grid: '4:1' },
  ]);
  assert.equal(players.length, 4);
  assert.equal(players.layoutMeta.confidence, 'medium');
  assert.equal(Object.keys(players).includes('layoutMeta'), false);
});

test('valid formation with a missing grid cell downgrades confidence without losing semantic bands', () => {
  const players = playersForFormation('4-2-3-1');
  const midfielder = players.find(player => player.grid === '3:1');
  midfielder.grid = null;
  midfielder.position = 'MF';
  const result = formation.layoutFormation(players, '4-2-3-1');
  assert.equal(result.confidence, 'medium');
  assert.ok(['DM', 'AM'].includes(result.players.find(player => player.name === midfielder.name).layoutBand));
  assert.equal(result.players.find(player => player.name === 'GK').y, formation.BAND_Y.GK);
});
