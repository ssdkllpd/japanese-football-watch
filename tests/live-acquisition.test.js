'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
function binding(db) {
  const prepare=(sql,params=[])=>({bind(...args){return prepare(sql,args);},async all(){const results=db.prepare(sql).all(...params);return {success:true,results,meta:{rows_written:/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)?Number(db.prepare('SELECT changes() AS n').get().n):0}};},async run(){const r=db.prepare(sql).run(...params);return {success:true,meta:{changes:Number(r.changes),rows_written:Number(r.changes)}};}});
  let pending=Promise.resolve();
  return {prepare,batch(statements){const run=pending.then(async()=>{db.exec('BEGIN');try {const rows=[];for(const stmt of statements)rows.push(await stmt.all());db.exec('COMMIT');return rows;}catch(error){db.exec('ROLLBACK');throw error;}});pending=run.catch(()=>{});return run;}};
}
function database(t) {const db=new DatabaseSync(':memory:');for(const name of fs.readdirSync(path.join(__dirname,'../migrations/live')).filter(name=>name.endsWith('.sql')).sort())db.exec(fs.readFileSync(path.join(__dirname,'../migrations/live',name),'utf8'));t.after(()=>db.close());return {db,LIVE_DB:binding(db)};}
const now=Date.parse('2026-10-16T10:00:00Z');
function provider(options={}) {
  const calls=[];
  const request=async(url,init)=>{
    calls.push(url);assert.equal(init.redirect,'manual');assert.equal(init.headers['x-apisports-key'],'test-provider-secret');
    if(options.http) return new Response(null,{status:options.http});
    const headers=options.noHeader?{}:{'x-ratelimit-requests-remaining':String(options.remaining??6000),'x-ratelimit-remaining':'300'};
    if(url.includes('/status')) return Response.json({response:{requests:{limit_day:10000,current:10000-(options.remaining??6000)}}},{headers});
    return Response.json({response:[],errors:options.error?{scope:'invalid'}:[],paging:{total:options.pages??1}},{headers});
  };
  return {calls,request};
}

test('preflight windows require distinct two-hour and one-hour confirmations',async()=>{
  const {precheckStage,liveEligible}=await import('../shared/live-contract.mjs');
  const row={status:'NS',kickoff_ms:now+2*3600000,check_2h_ms:null,check_1h_ms:null};
  assert.equal(precheckStage(row,now-1),null);
  assert.equal(precheckStage(row,now),'2h');
  assert.equal(liveEligible(row,now),false);
  const confirmed={...row,check_2h_ms:now};
  assert.equal(precheckStage(confirmed,now+3600000),'1h');
  assert.equal(liveEligible(confirmed,now+3600000),false);
  assert.equal(liveEligible({...confirmed,check_1h_ms:now+3600000},now+3600000),true);
  for(const status of ['PST','CANC','FT','AET','PEN','ABD','WO']) assert.equal(liveEligible({...confirmed,status,check_1h_ms:now},now+3600000),false);
});

test('scope is numeric and malformed targeted fixtures fail instead of publishing null IDs',async()=>{
  const {providerFixture}=await import('../shared/live-contract.mjs');
  assert.equal(providerFixture({league:{id:140}},new Set([39])),null);
  assert.throws(()=>providerFixture({league:{id:39},fixture:{id:1,date:'not-a-date',status:{short:'NS'}}},new Set([39])),/invalid_provider_fixture/);
});

test('fresh quota is checked before data and cached reserve stops every further call',async t=>{
  const {providerSession}=await import('../live-worker/index.mjs');
  const {db,LIVE_DB}=database(t),wire=provider({remaining:1199});
  const env={LIVE_DB,API_FOOTBALL_KEY:'test-provider-secret'};
  const session=await providerSession(env,now,wire.request);
  await assert.rejects(session.read('/fixtures',{live:'all'}),/quota_reserved/);
  await assert.rejects(providerSession(env,now+60000,wire.request),/quota_reserved/);
  assert.equal(wire.calls.length,1);
  assert.equal(db.prepare('SELECT requests FROM live_budget').get().requests,1);
});

test('local live-request ceiling is atomic and independent of reported daily provider quota',async t=>{
  const {providerSession,LIMITS}=await import('../live-worker/index.mjs');
  const {db,LIVE_DB}=database(t),wire=provider();
  db.prepare('INSERT INTO live_budget(utc_day,requests) VALUES(?,?)').run('2026-10-16',LIMITS.dailyRequests);
  await assert.rejects(providerSession({LIVE_DB,API_FOOTBALL_KEY:'test-provider-secret'},now,wire.request),/live_request_budget/);
  assert.equal(wire.calls.length,0);
});

test('UTC reset uses a new budget and re-reads provider quota',async t=>{
  const {providerSession}=await import('../live-worker/index.mjs');
  const {db,LIVE_DB}=database(t),wire=provider();
  db.prepare('INSERT INTO live_budget(utc_day,requests,remaining) VALUES(?,?,?)').run('2026-10-15',4000,0);
  const session=await providerSession({LIVE_DB,API_FOOTBALL_KEY:'test-provider-secret'},now,wire.request);
  assert.equal(session.remaining,6000);assert.equal(wire.calls.length,1);
});

for(const [name,options,error] of [
  ['redirect',{http:302},/provider_http_error/],['rate limit',{http:429},/provider_rate_limited/],
  ['API error',{error:true},/provider_response_error/],['unexpected pagination',{pages:2},/provider_payload_incomplete/],
  ['missing quota headers',{noHeader:true},/provider_quota_unknown/],
]) test(`provider ${name} cannot publish unverified live data`,async t=>{
  const {providerSession}=await import('../live-worker/index.mjs');
  const {LIVE_DB}=database(t),wire=provider(options);
  if(options.http) await assert.rejects(providerSession({LIVE_DB,API_FOOTBALL_KEY:'test-provider-secret'},now,wire.request),error);
  else {const session=await providerSession({LIVE_DB,API_FOOTBALL_KEY:'test-provider-secret'},now,wire.request);await assert.rejects(session.read('/fixtures',{live:'all'}),error);}
});

test('paid write ceiling protects the existing conservative account headroom',async t=>{
  const {providerSession,LIMITS}=await import('../live-worker/index.mjs');
  const {db,LIVE_DB}=database(t),wire=provider();
  db.prepare('INSERT INTO live_budget(utc_day,rows_written) VALUES(?,?)').run('2026-10-16',LIMITS.dailyRows);
  await assert.rejects(providerSession({LIVE_DB,API_FOOTBALL_KEY:'test-provider-secret'},now,wire.request),/live_write_budget/);
  assert.equal(wire.calls.length,0);
});

test('active public live reads never inspect the provider secret or perform upstream fetches',async t=>{
  const {storedLiveResponse}=await import('../worker/index.mjs');
  const {db,LIVE_DB}=database(t);
  db.prepare("UPDATE live_control SET heartbeat_ms=?,enabled=1,status='polling' WHERE id=1").run(now);
  db.prepare('INSERT INTO live_snapshots VALUES(?,?,?)').run('af:fixture:1',JSON.stringify({fixtureId:'af:fixture:1',competitionId:'af:competition:39',dateJst:'2026-10-16',status:{short:'1H'},home:{score:1}}),now);
  t.mock.method(globalThis,'fetch',()=>{throw new Error('upstream forbidden');});
  const env={LIVE_DB,LIVE_DATA_READ_ENABLED:'true',LIVE_COMPETITION_IDS:'39',get API_FOOTBALL_KEY(){throw new Error('public provider key forbidden');}};
  const responses=await Promise.all(Array.from({length:8},()=>storedLiveResponse(env,now)));
  for(const response of responses){assert.equal(response.headers.get('x-jfw-data-source'),'d1-live');assert.equal((await response.json()).fixtures[0].home.score,1);}
  assert.equal(globalThis.fetch.mock.callCount(),0);
});

test('fresh heartbeat with an acquisition error is still shown as stale',async t=>{
  const {storedLiveResponse}=await import('../worker/index.mjs');const {db,LIVE_DB}=database(t);
  db.prepare("UPDATE live_control SET heartbeat_ms=?,enabled=1,status='error' WHERE id=1").run(now);
  const body=await(await storedLiveResponse({LIVE_DB,LIVE_DATA_READ_ENABLED:'true'},now)).json();assert.equal(body.stale,true);
});

test('unavailable live storage fails closed without calling the provider',async()=>{
  const {storedLiveResponse}=await import('../worker/index.mjs');
  const body=await(await storedLiveResponse({LIVE_DATA_READ_ENABLED:'true'},now)).json();
  assert.equal(body.reason,'acquisition_unavailable');assert.equal(body.liveUpdatesEnabled,false);assert.deepEqual(body.fixtures,[]);
});

test('status wire contract uses limit_day and rejects missing or invalid quota metadata',async t=>{
 const {providerSession}=await import('../live-worker/index.mjs');
 for(const [requests,remaining] of [
  [{current:'100',limit_day:'7500'},7400],
  [{current:100,limit:7500},null],
  [{current:null,limit_day:null},null],
  [{current:8,limit_day:7},null],
 ]) {
  const {LIVE_DB}=database(t);
  const invoke=()=>providerSession({LIVE_DB,API_FOOTBALL_KEY:'test'},now,async()=>Response.json({response:{requests}}));
  if(remaining===null) await assert.rejects(invoke(),/provider_quota_unknown/);
  else assert.equal((await invoke()).remaining,remaining);
 }
});

test('provider diagnostics are bounded, redact the credential and remain outside public reads',async t=>{
 const {providerSession}=await import('../live-worker/index.mjs');
 const {db,LIVE_DB}=database(t),wire=provider();
 const session=await providerSession({LIVE_DB,API_FOOTBALL_KEY:'test-provider-secret'},now,wire.request);
 const env={LIVE_DB,API_FOOTBALL_KEY:'test-provider-secret'};
 await assert.rejects(providerSession(env,now+1,async()=>Response.json({errors:{token:'Rejected test-provider-secret'}})),/provider_response_error/);
 const row=db.prepare('SELECT * FROM live_provider_errors').get();
 assert.equal(row.endpoint,'/status');assert.match(row.error_detail,/\[redacted\]/);assert.doesNotMatch(row.error_detail,/test-provider-secret/);
 const {storedLiveResponse}=await import('../worker/index.mjs');
 const response=await storedLiveResponse({...env,LIVE_DATA_READ_ENABLED:'true'},now);
 assert.doesNotMatch(await response.text(),/Rejected|error_detail|test-provider-secret/);
});
