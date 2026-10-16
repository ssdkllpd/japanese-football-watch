import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { providerFixture,jstDate } from '../../shared/live-contract.mjs';
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../../',import.meta.url));
const modulePath=process.env.JFW_WRANGLER_MODULE||'wrangler';
const wranglerRoot=path.dirname(require.resolve(`${modulePath}/package.json`));
assert.equal(JSON.parse(fs.readFileSync(path.join(wranglerRoot,'package.json'))).version,'4.147.0');
const {Miniflare,convertV4MiniflareOptions}=require(require.resolve('miniflare',{paths:[wranglerRoot]}));
const {buildSync}=require(require.resolve('esbuild',{paths:[wranglerRoot]}));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'jfw-live-native-'));
const source=`import liveWorker,{scheduledTick} from ${JSON.stringify(path.join(root,'live-worker/index.mjs'))};
 import {storedLiveResponse} from ${JSON.stringify(path.join(root,'worker/index.mjs'))};
 export default {async fetch(request,env) {
   const input=await request.json();
   if(input.public) return storedLiveResponse({...env,LIVE_DATA_READ_ENABLED:'true'},input.now);
   try {if(input.nativeScheduled){await liveWorker.scheduled({scheduledTime:input.now},{...env,LIVE_ACQUISITION_ENABLED:'true'},{waitUntil(){}});return Response.json({nativeScheduled:true});}
   return Response.json(await scheduledTick({scheduledTime:input.now},{...env,LIVE_ACQUISITION_ENABLED:input.enabled===false?'false':'true'},fetch,input.now));}
   catch(error){return Response.json({error:error.message},{status:500});}
 }};`;
const bundle=buildSync({stdin:{contents:source,resolveDir:root,sourcefile:'live-test.mjs'},bundle:true,format:'esm',platform:'browser',write:false});
const base=Math.floor(Date.now()/60000)*60000;
const fixtures=new Map();
function raw(id,kickoff,status='NS',score=null) {
  return {fixture:{id,date:new Date(kickoff).toISOString(),status:{short:status,long:status,elapsed:status==='1H'?10:null}},league:{id:39,season:2026},
    teams:{home:{id:id*2,name:'Home',logo:null},away:{id:id*2+1,name:'Away',logo:null}},goals:{home:score,away:score===null?null:0}};
}
let remaining=6000,redirect=false,calls=[],runtime;
try {
  runtime=new Miniflare(convertV4MiniflareOptions({modulesRoot:temp,modules:[{type:'ESModule',path:path.join(temp,'harness.mjs'),contents:bundle.outputFiles[0].text}],
    compatibilityDate:'2026-10-08',d1Databases:['LIVE_DB','FOOTBALL_DB'],
    bindings:{API_FOOTBALL_KEY:'native-test-only',LIVE_COMPETITION_IDS:'39'},
    outboundService:async request=>{
      const url=new URL(request.url);assert.equal(url.origin,'https://v3.football.api-sports.io');
      assert.equal(request.headers.get('x-apisports-key'),'native-test-only');
      calls.push(url.pathname+url.search);
      if(redirect) return new Response(null,{status:302,headers:{location:'https://untrusted.invalid/'}});
      const headers={'x-ratelimit-requests-remaining':String(remaining),'x-ratelimit-remaining':'300'};
      if(url.pathname==='/status') return Response.json({response:{requests:{limit_day:10000,current:10000-remaining}}},{headers});
      assert.equal(url.pathname,'/fixtures');
      let rows=[...fixtures.values()];
      if(url.searchParams.has('ids')) {const ids=url.searchParams.get('ids').split('-').map(Number);rows=rows.filter(row=>ids.includes(row.fixture.id));}
      else if(url.searchParams.has('live')) rows=rows.filter(row=>['1H','2H','HT'].includes(row.fixture.status.short));
      else {assert.ok(url.searchParams.has('date'));rows=rows.filter(row=>jstDate(Date.parse(row.fixture.date))===url.searchParams.get('date'));}
      return Response.json({response:rows,errors:[],paging:{current:1,total:1}},{headers});
    }}));
  const db=await runtime.getD1Database('LIVE_DB'),core=await runtime.getD1Database('FOOTBALL_DB');
  const schema=fs.readFileSync(path.join(root,'migrations/live/0001_live.sql'),'utf8');
  await db.batch(schema.replace(/^--.*$/gm,'').split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
  const coreSchema=`CREATE TABLE fixtures(provider_id INTEGER,competition_season_id INTEGER,home_team_id INTEGER,away_team_id INTEGER,kickoff_utc TEXT,status_short TEXT,status_long TEXT,status_elapsed INTEGER,home_goals INTEGER,away_goals INTEGER,ingestion_state TEXT);
CREATE TABLE competition_seasons(id INTEGER,competition_id INTEGER,provider_season INTEGER);
CREATE TABLE competitions(id INTEGER,provider_id INTEGER);
CREATE TABLE teams(id INTEGER,provider_id INTEGER,name TEXT,logo_url TEXT);`;
  await core.batch(coreSchema.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>core.prepare(sql)));
  const send=async input=>{const response=await runtime.dispatchFetch('http://test.local/',{method:'POST',body:JSON.stringify(input)});return {status:response.status,body:await response.json()};};
  const row=async id=>db.prepare('SELECT * FROM live_schedule WHERE fixture_id=?').bind(`af:fixture:${id}`).first();
  const control=()=>db.prepare('SELECT * FROM live_control WHERE id=1').first();
  await db.prepare('UPDATE live_control SET daily_day=? WHERE id=1').bind(jstDate(base)).run();
  const off=await send({now:base,enabled:false});assert.equal(off.body.status,'disabled');assert.equal(calls.length,0);
  fixtures.set(101,raw(101,base+3*3600000));fixtures.set(102,raw(102,base+3*3600000));
  for(const value of fixtures.values()) {
    const dto=providerFixture(value,new Set([39]));
    await db.prepare('INSERT INTO live_schedule(fixture_id,provider_id,competition_id,kickoff_ms,status,payload) VALUES(?,?,?,?,?,?)')
      .bind(dto.fixtureId,value.fixture.id,39,Date.parse(dto.kickoffUtc),'NS',JSON.stringify(dto)).run();
  }
  assert.equal((await send({now:base+60000})).body.status,'idle');assert.equal(calls.length,0,'no continuous provider calls before the window');
  const two=await send({now:base+3600000});assert.equal(two.status,200,JSON.stringify(two));assert.equal(two.body.status,'idle');
  assert.ok((await row(101)).check_2h_ms);assert.equal((await row(101)).check_1h_ms,null);assert.equal(calls.length,2,'status plus one grouped schedule request');
  // One fixture moves; the other must still start live polling at its one-hour check.
  fixtures.set(102,raw(102,base+8*3600000));
  const one=await send({now:base+2*3600000});assert.equal(one.body.status,'polling',JSON.stringify(one));
  assert.ok((await row(101)).check_1h_ms);assert.equal((await row(102)).check_1h_ms,null);
  assert.equal((await row(102)).kickoff_ms,base+8*3600000);assert.equal((await row(101)).missing_since_ms,base+2*3600000);
  const before=calls.length;
  await send({now:base+2.5*3600000});
  assert.equal(calls.slice(before).filter(url=>url.includes('ids=')).length,1,'thirty minutes without data must trigger schedule confirmation');
  fixtures.set(101,raw(101,base+3*3600000,'1H',1));
  const active=await send({now:base+3*3600000});assert.equal(active.body.liveFixtures,1,JSON.stringify(active));
  const snapshot=await db.prepare('SELECT payload FROM live_snapshots WHERE fixture_id=?').bind('af:fixture:101').first();
  assert.equal(JSON.parse(snapshot.payload).home.score,1);
  const count=calls.length;
  const publicReads=await Promise.all(Array.from({length:8},()=>send({public:true,now:base+3*3600000})));
  for(const response of publicReads) {assert.equal(response.body.liveUpdatesEnabled,true);assert.equal(response.body.fixtures[0].home.score,1);}
  assert.equal(calls.length,count,'public reads must never call the provider');
  const deliveries=await Promise.all(Array.from({length:8},()=>send({now:base+3*3600000+60000})));
  assert.equal(deliveries.filter(result=>result.body.status==='duplicate_or_busy').length,7,'real D1 must serialize concurrent cron deliveries');
  assert.equal(calls.length-count,2,'only status plus one live request for all deliveries');
  fixtures.set(101,raw(101,base+3*3600000,'FT',2));
  await send({now:base+3*3600000+120000});
  assert.equal((await row(101)).status,'FT','live disappearance must immediately confirm the final status');
  assert.equal(JSON.parse((await db.prepare('SELECT payload FROM live_snapshots WHERE fixture_id=?').bind('af:fixture:101').first()).payload).home.score,2);
  const finishedCalls=calls.length;
  assert.equal((await send({now:base+3*3600000+180000})).body.status,'idle');
  assert.equal(calls.length,finishedCalls,'end of all active games stops provider polling');
  // Move the remaining game into a confirmed window and exercise the reserve.
  await db.prepare("UPDATE live_schedule SET kickoff_ms=?,check_2h_ms=?,check_1h_ms=? WHERE fixture_id='af:fixture:102'").bind(base+3*3600000,base,base).run();
  remaining=1199;
  assert.equal((await send({now:base+3*3600000+240000})).body.status,'quota_reserved');
  const reservedCalls=calls.length;
  assert.equal((await send({now:base+3*3600000+300000})).body.status,'quota_reserved');
  assert.equal(calls.length,reservedCalls,'known exhausted reserve must not make additional calls');
  await db.prepare('UPDATE live_budget SET remaining=6000').run();remaining=6000;redirect=true;
  const denied=await send({now:base+3*3600000+360000});assert.equal(denied.status,500);assert.equal(denied.body.error,'provider_http_error');redirect=false;
  // Fresh daily acquisition, including the core read and both JST dates.
  fixtures.clear();await db.prepare('DELETE FROM live_schedule').run();
  await db.prepare('UPDATE live_control SET daily_day=NULL').run();
  const dailyBefore=calls.length;
  const daily=await send({now:base+3*3600000+420000});assert.equal(daily.body.status,'idle',JSON.stringify(daily));
  assert.equal(calls.length-dailyBefore,3,'one daily check is status plus today/tomorrow schedule reads');
  assert.equal((await control()).daily_day,jstDate(base+3*3600000+420000));
  const stale=await send({public:true,now:base+3*3600000+720000});assert.equal(stale.body.stale,true);
  assert.ok((await db.prepare('SELECT rows_written FROM live_budget').first()).rows_written>0,'billable D1 write metadata must be counted');
  await db.prepare('UPDATE live_control SET last_tick_ms=0,lease_until_ms=0,daily_day=NULL').run();
  const nativeBefore=calls.length;
  const native=await send({nativeScheduled:true,now:Math.floor(Date.now()/60000)*60000});
  assert.equal(native.status,200,JSON.stringify(native));assert.equal(native.body.nativeScheduled,true);
  assert.ok(calls.length>nativeBefore,'the default scheduled handler must use native fetch, not its execution context');
  console.log('PASS: native workerd/D1 live scheduling, reschedule isolation, no-data checks, public reads, concurrent claims, finals, reserve, redirects, daily discovery, stale detection');
} finally {await runtime?.dispose();fs.rmSync(temp,{recursive:true,force:true});}
