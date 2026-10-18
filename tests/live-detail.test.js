'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createLocalD1}=require('../scripts/d1/local-d1');

async function harness(t) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const name of fs.readdirSync(path.join(__dirname,'../migrations/live')).filter(n=>n.endsWith('.sql')).sort())db.exec(fs.readFileSync(path.join(__dirname,'../migrations/live',name),'utf8'));
 const binding=createLocalD1(db);
 // Read batches, like Cloudflare D1, return each SELECT result.
 binding.batch=async statements=>{
  db.exec('BEGIN');try{const out=[];for(const stmt of statements)out.push(await stmt.all());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}
 };
 const now=Date.parse('2026-10-18T10:00:00Z');
 const raw={fixture:{id:10,date:new Date(now+30*60000).toISOString(),status:{short:'NS',elapsed:null}},
  league:{id:39,season:2026,name:'Premier League'},teams:{home:{id:1,name:'Home Club'},away:{id:2,name:'Away Club'}},
  goals:{home:null,away:null},lineups:[],events:[],statistics:[],players:[]};
 const {providerFixture}=await import('../shared/live-contract.mjs');
 const dto=providerFixture(raw,new Set([39]));
 db.prepare('INSERT INTO live_schedule(fixture_id,provider_id,competition_id,kickoff_ms,status,payload,check_2h_ms,check_1h_ms) VALUES(?,?,?,?,?,?,?,?)')
  .run(dto.fixtureId,10,39,Date.parse(dto.kickoffUtc),'NS',JSON.stringify(dto),now-3600000,now-60000);
 db.prepare('UPDATE live_control SET daily_day=?,last_core_sync_ms=?').run('2026-10-18',now);
 const calls=[],fixtures=new Map([[10,raw]]);
 const request=async url=>{
  calls.push(url);const parsed=new URL(url),headers={'x-ratelimit-requests-remaining':'6000','x-ratelimit-remaining':'300'};
  if(parsed.pathname==='/status')return Response.json({response:{requests:{limit_day:10000,current:4000}}},{headers});
  assert.equal(parsed.pathname,'/fixtures');
  let rows=[...fixtures.values()];
  if(parsed.searchParams.has('live'))rows=rows.filter(row=>['1H','2H','HT'].includes(row.fixture.status.short));
  if(parsed.searchParams.has('ids'))rows=rows.filter(row=>parsed.searchParams.get('ids').split('-').map(Number).includes(row.fixture.id));
  return Response.json({response:rows,errors:[],paging:{current:1,total:1}},{headers});
 };
 const {normalizeFixtureBundle}=require('../scripts/v2/fixture-contract');
 let core=normalizeFixtureBundle(raw,{fetchedAt:new Date(now).toISOString()});
 const env={LIVE_DB:binding,LIVE_ACQUISITION_ENABLED:'true',API_FOOTBALL_KEY:'unit-only',LIVE_COMPETITION_IDS:'39',
  LIVE_DATA_READ_ENABLED:'true',FOOTBALL_DB:{prepare:()=>({bind:()=>({all:async()=>({success:true,results:[]})})})},
  FOOTBALL_DATA:{get:async key=>key.includes('/indexes/')?{text:async()=>JSON.stringify({fixtureId:'af:fixture:10',key:'fixture.json'})}:{text:async()=>JSON.stringify(core)}}};
 const {scheduledTick}=await import('../live-worker/index.mjs');
 const {fixtureDetailResponse}=await import('../worker/index.mjs');
 const read=async stamp=>{const response=await fixtureDetailResponse(env,'af:fixture:10',null,stamp);assert.equal(response.status,200);return {body:await response.json(),source:response.headers.get('x-jfw-data-source')};};
 return {db,now,raw,calls,env,fixtures,tick:stamp=>scheduledTick({scheduledTime:stamp},env,request,stamp),read,setCore:value=>{core=value;}};
}

test('announced pre-match lineups, live corrections and final details flow through stored data only',async t=>{
 const h=await harness(t),minute=60000;
 await h.tick(h.now);
 assert.equal((await h.read(h.now)).body.lineups.length,0);
 h.raw.lineups=[{team:{id:1},formation:'4-3-3',startXI:[{player:{id:100,name:'Starter',number:9,pos:'F',grid:'4:1'}}],substitutes:[],coach:{id:5,name:'Coach'}}];
 const before=h.calls.length;
 await h.tick(h.now+minute);
 assert.equal(h.calls.slice(before).filter(url=>url.includes('ids=')).length,0,'unannounced lineup polling stays on its five-minute cadence');
 await h.tick(h.now+5*minute);
 let result=await h.read(h.now+5*minute);
 assert.equal(result.source,'d1-live');assert.equal(result.body.lineups[0].startXI[0].id,'af:player:100');
 assert.equal(result.body.fixture.status.short,'NS');
 h.raw.fixture.status={short:'1H',elapsed:12};h.raw.goals={home:1,away:0};
 h.raw.events=[{time:{elapsed:12},team:{id:1},player:{id:100,name:'Starter'},type:'Goal',detail:'Normal Goal'}];
 h.raw.players=[{team:{id:1},players:[{player:{id:100,name:'Starter'},statistics:[{games:{minutes:12,rating:'7.5',position:'F',substitute:false},goals:{total:1}}]}]}];
 h.raw.statistics=[{team:{id:1},statistics:[{type:'Total Shots',value:3}]}];
 await h.tick(h.now+30*minute);
 result=await h.read(h.now+30*minute);
 assert.equal(result.body.events[0].type,'goal');assert.equal(result.body.playerStats[0].values.rating,7.5);
 assert.equal(result.body.teamStats[0].values.total_shots,3);
 const providerCount=h.calls.length;
 await h.read(h.now+30*minute);await h.read(h.now+30*minute);
 assert.equal(h.calls.length,providerCount,'viewers cannot spend provider requests');
 h.raw.events=[];delete h.raw.lineups;
 await h.tick(h.now+32*minute);
 result=await h.read(h.now+32*minute);
 assert.equal(result.body.events.length,0,'explicit empty events remove a reversed goal');
 assert.equal(result.body.lineups[0].startXI.length,1,'an omitted section preserves acquired players');
 assert.ok(result.body.fixture.provenance.issues.includes('live_retained_lineups'));
 h.raw.fixture.status={short:'FT',elapsed:90};h.raw.goals={home:2,away:0};
 await h.tick(h.now+33*minute);
 result=await h.read(h.now+33*minute);
 assert.equal(result.body.fixture.ingestionState,'provisional_final');assert.equal(result.body.fixture.score.goals.home,2);
 const final=require('../scripts/v2/fixture-contract').normalizeFixtureBundle(h.raw,{fetchedAt:new Date(h.now+34*minute).toISOString(),finalized:true});
 h.setCore(final);
 result=await h.read(h.now+34*minute);
 assert.equal(result.body.fixture.ingestionState,'finalized');assert.notEqual(result.source,'d1-live');
});

test('scope violations fail before returning provisional data; missing sections and stale reads stay explicit',async t=>{
 const h=await harness(t);
 const {providerDetail}=await import('../shared/live-detail.mjs');
 assert.throws(()=>providerDetail({...h.raw,lineups:[{team:{id:999}}]},new Set([39]),h.now),/team_mismatch/);
 assert.throws(()=>providerDetail({...h.raw,events:{}},new Set([39]),h.now),/invalid_live_detail_section/);
 await h.tick(h.now);
 let result=await h.read(h.now+7*60000);
 assert.ok(result.body.fixture.provenance.issues.includes('live_detail_stale'));
 h.env.LIVE_COMPETITION_IDS='78';
 result=await h.read(h.now);
 assert.notEqual(result.source,'d1-live');
 h.env.LIVE_COMPETITION_IDS='39';h.env.LIVE_DATA_READ_ENABLED='false';
 assert.notEqual((await h.read(h.now)).source,'d1-live');
});

test('simultaneous fixtures use batches of at most twenty without extra detail calls inside the cadence',async t=>{
 const h=await harness(t);
 const {providerFixture}=await import('../shared/live-contract.mjs');
 for(let id=11;id<=31;id++) {
  const raw=structuredClone(h.raw);raw.fixture.id=id;h.fixtures.set(id,raw);
  const dto=providerFixture(raw,new Set([39]));
  h.db.prepare('INSERT INTO live_schedule(fixture_id,provider_id,competition_id,kickoff_ms,status,payload,check_2h_ms,check_1h_ms) VALUES(?,?,?,?,?,?,?,?)')
   .run(dto.fixtureId,id,39,Date.parse(dto.kickoffUtc),'NS',JSON.stringify(dto),h.now-3600000,h.now-60000);
 }
 await h.tick(h.now);
 const grouped=h.calls.map(url=>new URL(url).searchParams.get('ids')).filter(Boolean);
 assert.deepEqual(grouped.map(ids=>ids.split('-').length),[20,2]);
 assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM live_details').get().n,22);
 const before=h.calls.length;await h.tick(h.now+60000);
 assert.equal(h.calls.slice(before).filter(url=>url.includes('ids=')).length,0);
});
