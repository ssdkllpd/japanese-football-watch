const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { applyMigrations } = require('../scripts/d1/migration-inventory');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const { build } = require('../all-player-stats');
const reviewedIds = require('../tracked-player-provider-ids');

const player = (nationality = 'Japan', team = 10) => ({ id: 7, name: 'K. Example', nationality,
  birthDate: '2000-01-02', photo: null,
  teams: [{ id: team, name: team === 10 ? 'First Club' : 'Second Club', logo: null, source: 'team_squad' }] });
const runId = date => `${date}T12:00:00.000Z`;
const batch = (observedOn, players) => ({ schemaVersion: 'jfw-d1-admin-ingest/1',
  operation: 'player_roster_upsert', observedOn, runId: runId(observedOn), players });
const complete = (observedOn, expectedPlayers) => ({ schemaVersion: 'jfw-d1-admin-ingest/1',
  operation: 'player_roster_complete', observedOn, runId: runId(observedOn), expectedPlayers });

test('roster upsert preserves player ID and prior team observations after a transfer', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  applyMigrations(db, path.join(__dirname, '..'));
  db.exec("INSERT INTO provider_sources(code,api_version) VALUES ('api-football','v3')");
  const { assertPlayerRosterRequest, publishPlayerRoster, completePlayerRoster } = await import('../admin-worker/player-roster-ingest.mjs');
  const { default: worker } = await import('../worker/index.mjs');
  const env = { FOOTBALL_DB: createLocalD1(db), APP_ORIGINS: 'https://example.github.io' };
  await publishPlayerRoster(env, assertPlayerRosterRequest(batch('2026-09-08', [player()])));
  const get = async url => {
    const response = await worker.fetch(new Request(`https://worker.test${url}`, {
      headers: { origin: 'https://example.github.io' },
    }), env);
    assert.equal(response.status, 200);
    return response.json();
  };
  const incomplete = await get('/api/v2/players?nationality=Japan');
  assert.deepEqual(incomplete.players[0].rosterTeams, []);
  await completePlayerRoster(env, assertPlayerRosterRequest(complete('2026-09-08', 1)));
  await publishPlayerRoster(env, assertPlayerRosterRequest(batch('2026-10-17', [player(null, 20)])));
  const pending = await get('/api/v2/players?nationality=Japan');
  assert.deepEqual(pending.players[0].rosterTeams.map(item => item.id), ['af:team:10']);
  await completePlayerRoster(env, assertPlayerRosterRequest(complete('2026-10-17', 1)));
  const japan = await get('/api/v2/players?nationality=Japan');
  assert.equal(japan.players.length, 1);
  assert.equal(japan.players[0].id, 'af:player:7');
  assert.equal(japan.players[0].nationality, 'Japan');
  assert.equal(japan.players[0].rosterObservedOn, '2026-10-17');
  assert.deepEqual(japan.players[0].rosterTeams.map(item => item.id), ['af:team:20']);
  const oldClub = await get('/api/v2/players?nationality=all&team=af%3Ateam%3A10');
  assert.equal(oldClub.players.length, 0);
  const profile = await get('/api/v2/players/af%3Aplayer%3A7');
  assert.deepEqual(profile.rosterHistory.map(item => item.id), ['af:team:20', 'af:team:10']);
  await assert.rejects(async () => completePlayerRoster(env, assertPlayerRosterRequest(complete('2026-10-18', 1))), /differs/);
  await assert.rejects(async () => assertPlayerRosterRequest(batch('2026-10-17', [player(), player()])), /Duplicate/);
});

test('roster identities use provider IDs, and fixture team aggregates survive a transfer', async () => {
  const { normalizeRoster } = await import('../scripts/v2/sync-player-roster.mjs');
  const profiles = normalizeRoster([{ player: { id: 7, name: 'K. Example', nationality: 'Japan' },
    statistics: [{ team: { id: 10, name: 'First Club' }, league: { id: 39 } }] }],
  [{ team: { id: 20, name: 'Second Club' }, players: [{ id: 7, name: 'K. Example' }] }]);
  assert.deepEqual(profiles[0].teams.map(team => team.id), [10, 20]);
  const row = (team, apps, goals) => ({ player: { id: 'af:player:7', providerId: 7, name: 'K. Example' },
    team: { id: team, name: team }, appearances: apps,
    goals: { presence: 'present', value: goals, observed: apps, total: apps },
    assists: { presence: 'not_fetched', value: null, observed: 0, total: apps },
    minutes: { presence: 'present', value: apps * 90, observed: apps, total: apps },
    redCards: { presence: 'present', value: 0, observed: apps, total: apps } });
  const result = build([{ competition: { id: 'af:competition:39' }, playerStats: { presence: 'present',
    teamRows: [row('af:team:10', 2, 1), row('af:team:20', 1, 0)] } }]).get('af:player:7');
  assert.equal(result.seasonStats.apps, 3);
  assert.equal(result.seasonStats.goals, 1);
  assert.equal(result.seasonStats.assists, null);
  assert.equal(result.clubStats['af:team:10'].apps, 2);
  assert.equal(result.clubStats['af:team:20'].apps, 1);
});

test('all-player directory searches beyond the first page with a stable cursor', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  applyMigrations(db, path.join(__dirname, '..'));
  db.exec("INSERT INTO provider_sources(id,code,api_version) VALUES (1,'api-football','v3')");
  const insert = db.prepare('INSERT INTO players(canonical_id,source_id,provider_id,display_name,nationality) VALUES (?,1,?,?,?)');
  for (let id = 1; id <= 105; id++) insert.run(`af:player:${id}`, id, id === 105 ? 'Late Arrival' : `Player ${id}`, id % 2 ? 'Japan' : 'France');
  const { default: worker } = await import('../worker/index.mjs');
  const env = { FOOTBALL_DB: createLocalD1(db), APP_ORIGINS: 'https://example.github.io' };
  const get = async query => (await worker.fetch(new Request(`https://worker.test/api/v2/players?${query}`, {
    headers: { origin: 'https://example.github.io' },
  }), env)).json();
  const first = await get('nationality=all');
  assert.equal(first.players.length, 100);
  assert.equal(first.nextCursor, 100);
  const second = await get(`nationality=all&after=${first.nextCursor}`);
  assert.equal(second.players.length, 5);
  assert.equal(second.nextCursor, null);
  const searched = await get('nationality=all&q=Late%20Arrival');
  assert.deepEqual(searched.players.map(item => item.id), ['af:player:105']);
});

test('reviewed Japanese bridge preserves explicit legacy IDs without identity collisions', async () => {
  const fs = require('node:fs');
  const legacy = await require('../v2-backfill-data').loadCurrentMergedData({
    getJson: async file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')),
    mergeBackfillData: require('../backfill-merge').mergeBackfillData,
  });
  const names = new Set(legacy.players.map(item => item.name));
  assert.equal(Object.keys(reviewedIds).length, new Set(Object.values(reviewedIds)).size);
  for (const name of Object.keys(reviewedIds)) assert.ok(names.has(name), name);
  for (const item of legacy.players) {
    const explicit = new Set([item, ...(legacy.playerMatchStats || []).filter(row => row.playerId === item.playerId)]
      .map(row => row.providerIds?.apiFootball?.player).filter(Number.isInteger));
    if (explicit.size) assert.deepEqual([...explicit], [reviewedIds[item.name]], item.name);
  }
  assert.deepEqual(legacy.players.filter(item => !reviewedIds[item.name]).map(item => item.name), []);
});
