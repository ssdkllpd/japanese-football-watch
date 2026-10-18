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
const batch = (observedOn, players) => ({ schemaVersion: 'jfw-d1-admin-ingest/1',
  operation: 'player_roster_upsert', observedOn, runId: `${observedOn}T00:00:00.000Z`, players });

test('roster upsert preserves player ID and prior team observations after a transfer', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  applyMigrations(db, path.join(__dirname, '..'));
  db.exec("INSERT INTO provider_sources(code,api_version) VALUES ('api-football','v3')");
  const { assertPlayerRosterRequest, publishPlayerRoster, completePlayerRoster } = await import('../admin-worker/player-roster-ingest.mjs');
  const { default: worker } = await import('../worker/index.mjs');
  const env = { FOOTBALL_DB: createLocalD1(db), APP_ORIGINS: 'https://example.github.io' };
  await publishPlayerRoster(env, assertPlayerRosterRequest(batch('2026-09-08', [player()])));
  await completePlayerRoster(env, { observedOn:'2026-09-08', runId:'2026-09-08T00:00:00.000Z', expectedPlayers:1, expectedObservations:1, squadTeamIds:[10] });
  await publishPlayerRoster(env, assertPlayerRosterRequest(batch('2026-10-17', [player(null, 20)])));
  const get = async url => {
    const response = await worker.fetch(new Request(`https://worker.test${url}`, {
      headers: { origin: 'https://example.github.io' },
    }), env);
    assert.equal(response.status, 200);
    return response.json();
  };
  await completePlayerRoster(env, { observedOn:'2026-10-17', runId:'2026-10-17T00:00:00.000Z', expectedPlayers:1, expectedObservations:1, squadTeamIds:[20] });
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
  assert.deepEqual(result.clubNames, { 'af:team:10': 'af:team:10', 'af:team:20': 'af:team:20' });
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
  assert.equal(Object.keys(reviewedIds).length,64);
  const evidence=require('../config/tracked-player-provider-evidence.json');
  for (const item of evidence.identities) assert.equal(reviewedIds[item.legacyName],item.providerId);
});

test('unfinished and older runs never replace complete current squads; departing players leave the directory', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  applyMigrations(db, path.join(__dirname, '..'));
  db.exec("INSERT INTO provider_sources(code,api_version) VALUES ('api-football','v3')");
  const { publishPlayerRoster, completePlayerRoster, assertPlayerRosterRequest } = await import('../admin-worker/player-roster-ingest.mjs');
  const { default: worker } = await import('../worker/index.mjs');
  const env = { FOOTBALL_DB:createLocalD1(db), APP_ORIGINS:'https://example.github.io' };
  const get = async suffix => {
    const response = await worker.fetch(new Request('https://worker.test/api/v2/players'+suffix,{headers:{origin:'https://example.github.io'}}),env);
    assert.equal(response.status,200); return response.json();
  };
  const finish = (day, count, observations, teams) => completePlayerRoster(env, {observedOn:day,runId:`${day}T00:00:00.000Z`,expectedPlayers:count,expectedObservations:observations,squadTeamIds:teams});
  await publishPlayerRoster(env,assertPlayerRosterRequest(batch('2026-09-08',[player()])));
  await finish('2026-09-08',1,1,[10]);
  const changed=player('Japan',20);
  changed.teams.push({...player().teams[0],source:'season_players'});
  await publishPlayerRoster(env,assertPlayerRosterRequest(batch('2026-10-17',[changed])));
  assert.deepEqual((await get('?nationality=Japan')).players[0].rosterTeams.map(t=>t.id),['af:team:10']);
  await assert.rejects(finish('2026-10-17',2,2,[20]),/differs/);
  await assert.rejects(finish('2026-10-17',1,1,[20]),/differs/);
  await assert.rejects(finish('2026-10-17',1,2,[10]),/differs/);
  await finish('2026-10-17',1,2,[20]);
  assert.deepEqual((await get('?nationality=Japan')).players[0].rosterTeams.map(t=>t.id),['af:team:20']);
  await publishPlayerRoster(env,assertPlayerRosterRequest(batch('2026-09-09',[player('England')])));
  await finish('2026-09-09',1,1,[10]);
  const current=(await get('?nationality=Japan')).players;
  assert.equal(current[0].nationality,'Japan');
  assert.deepEqual(current[0].rosterTeams.map(t=>t.id),['af:team:20']);
  const other={...player(),id:8};
  await publishPlayerRoster(env,assertPlayerRosterRequest(batch('2026-10-18',[other])));
  await finish('2026-10-18',1,1,[10]);
  assert.deepEqual((await get('?nationality=Japan')).players.map(p=>p.providerId),[8]);
  const old=await get('/af%3Aplayer%3A7');
  assert.equal(old.player.rosterTeams.length,0);
  assert.equal(old.rosterHistory.length,2);
  await assert.rejects(publishPlayerRoster(env,assertPlayerRosterRequest(batch('2026-10-18',[player()]))),/completed/);
});

test('roster publication cannot activate a partially acknowledged upload',async()=>{
  const {publishRoster}=await import('../scripts/v2/sync-player-roster.mjs');
  const calls=[];const env={ADMIN_INGEST_URL:'https://admin.test',ADMIN_INGEST_TOKEN:'test'};
  await assert.rejects(publishRoster([player()],'2026-10-18',async(url,options)=>{
    calls.push(JSON.parse(options.body));return {ok:false,status:503,json:async()=>({ok:false})};
  },env),/rejected/);
  assert.deepEqual(calls.map(c=>c.operation),['player_roster_upsert']);
});

test('roster publication posts batches and completion to the admin ingest route from an origin or full URL', async () => {
  const { publishRoster } = await import('../scripts/v2/sync-player-roster.mjs');
  for (const configured of ['https://admin.test', 'https://admin.test/admin/v1/ingest?old=1#fragment']) {
    const calls = [];
    const published = await publishRoster([player()], '2026-10-18', async (url, options) => {
      assert.equal(url, 'https://admin.test/admin/v1/ingest');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, 'Bearer test');
      const input = JSON.parse(options.body);
      calls.push(input);
      const report = input.operation === 'player_roster_upsert'
        ? { players: input.players.length } : { completed: true, runId: input.runId };
      return { ok: true, json: async () => ({ ok: true, report }) };
    }, { ADMIN_INGEST_URL: configured, ADMIN_INGEST_TOKEN: 'test' });
    assert.equal(published, 1);
    assert.deepEqual(calls.map(item => item.operation), ['player_roster_upsert', 'player_roster_complete']);
  }
  let requested = false;
  await assert.rejects(publishRoster([player()], '2026-10-18', async () => { requested = true; }, {
    ADMIN_INGEST_URL: 'https://user:password@admin.test', ADMIN_INGEST_TOKEN: 'test',
  }), /must not contain credentials/);
  assert.equal(requested, false);
});

test('complete current roster pages and literal name searches reach players after the first page',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());applyMigrations(db,path.join(__dirname,'..'));
 db.exec("INSERT INTO provider_sources(code,api_version) VALUES('api-football','v3')");
 const {publishPlayerRoster,completePlayerRoster}=await import('../admin-worker/player-roster-ingest.mjs');
 const {default:worker}=await import('../worker/index.mjs');
 const env={FOOTBALL_DB:createLocalD1(db),APP_ORIGINS:'https://example.github.io'};
 const players=Array.from({length:105},(_,i)=>({...player(),id:i+1,name:i===104?'Late Arrival':`Player ${i+1}`}));
 for(let i=0;i<players.length;i+=40)await publishPlayerRoster(env,batch('2026-10-18',players.slice(i,i+40)));
 await completePlayerRoster(env,{runId:'2026-10-18T00:00:00.000Z',observedOn:'2026-10-18',expectedPlayers:105,expectedObservations:105,squadTeamIds:[10]});
 const get=async query=>{
  const response=await worker.fetch(new Request('https://worker.test/api/v2/players?'+query,{headers:{origin:'https://example.github.io'}}),env);
  assert.equal(response.status,200);return response.json();
 };
 const first=await get('nationality=all');assert.equal(first.players.length,100);assert.equal(first.nextCursor,100);
 const second=await get('nationality=all&after=100');assert.equal(second.players.length,5);assert.equal(second.nextCursor,null);
 assert.deepEqual((await get('nationality=all&q=late%20arrival')).players.map(p=>p.providerId),[105]);
 assert.equal((await get('nationality=all&q=%25')).players.length,0);
});

test('complete roster collection permits more than 1500 nationality lookups within the guarded request budget',async()=>{
 const {collectRoster}=await import('../scripts/v2/sync-player-roster.mjs');
 const leagues=[39,40,61,78,88,94,135,140,144,179];
 const teamIds=leagues.flatMap((_,index)=>Array.from({length:10},(_,i)=>index*10+i+1));
 let profileCalls=0;
 const client={get:async(endpoint,params)=>{
  if(endpoint==='teams')return {data:{response:teamIds.slice(leagues.indexOf(params.league)*10,leagues.indexOf(params.league)*10+10).map(id=>({team:{id,name:`Club ${id}`}}))}};
  if(endpoint==='players')return {data:{paging:{current:1,total:1},response:[{player:{id:100000+params.league,name:'Existing Player',nationality:'Japan'},statistics:[]}]}};
  if(endpoint==='players/squads')return {data:{response:[{team:{id:params.team,name:`Club ${params.team}`},players:Array.from({length:16},(_,i)=>({id:params.team*100+i+1,name:'New Player'}))}]}};
  if(endpoint==='players/profiles'){profileCalls++;return {data:{response:[{player:{id:params.player,name:'New Player',nationality:'Japan'}}]}};}
  throw new Error('Unexpected endpoint');
 }};
 const collected=await collectRoster(client);
 assert.equal(collected.teamCount,100);
 assert.equal(profileCalls,1600);
 assert.equal(collected.profiles.length,1600);
});
