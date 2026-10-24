'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const config=require('../config/cup-competitions.json');
function source(){
 return {schemaVersion:'jfw-cup-inspection/1',season:2026,observedAt:'2026-10-21T04:00:00.000Z',cups:config.competitions.map((target,i)=>({country:target.country,status:'available',metadata:{league:{id:target.providerId,name:target.label}},season:{start:'2026-07-01',end:'2026-12-31',current:true},standings:null,fixtures:[{fixture:{id:1000+i,date:'2026-10-21T12:00:00+00:00',status:{short:'NS',long:'Not Started',elapsed:null}},league:{id:target.providerId,season:2026,name:target.label,country:target.country,round:'Quarter-finals'},teams:{home:{id:1,name:'Club A'},away:{id:2,name:'Club B'}},goals:{home:null,away:null}}]}))};
}
async function prepared(){const {prepareCups}=await import('../scripts/cups/prepare.mjs');const raw=JSON.stringify(source());return prepareCups(raw,{source:{snapshotSha256:createHash('sha256').update(raw).digest('hex')}});}
function envOf(p){const objects=new Map(p.objects.map(o=>[o.key,o.text]));objects.set(p.catalogKey,JSON.stringify(p.catalog));return {objects,env:{FOOTBALL_DATA:{get:async key=>objects.has(key)?{body:objects.get(key),text:async()=>objects.get(key)}:null}}};}
test('saved cup schedules serve only acquired scopes, preserve same-year seasons and never need D1 or provider calls',async()=>{
 const {cupResponse,readCupCatalog}=await import('../worker/cup-snapshots.mjs');
 const p=await prepared(),{env}=envOf(p);assert.equal((await readCupCatalog(env)).length,14);
 let r=await cupResponse(env,'af:competition:848',{seasonId:'af:season:848:2026'});assert.equal(r.status,200);
 const data=await r.json();assert.equal(data.fixtures[0].round,'Quarter-finals');assert.equal(data.season.endsOn,'2026-12-31');assert.equal(data.cupSnapshot.automaticUpdates,true);
 assert.equal((await cupResponse(env,'af:competition:848',{seasonId:'af:season:848:2025'})).status,404);
 r=await cupResponse(env,'af:competition:48',{date:'2026-10-22'});assert.deepEqual((await r.json()).fixtures,[]);
 assert.equal((await cupResponse(env,'af:competition:48',{date:'2026-99-99'})).status,400);
 assert.equal((await cupResponse(env,'af:competition:48',{standings:true})).status,404);
});
test('cup source and public snapshot tampering fail closed; missing storage never fabricates a catalog',async()=>{
 const {prepareCups}=await import('../scripts/cups/prepare.mjs');const {cupResponse,readCupCatalog}=await import('../worker/cup-snapshots.mjs');
 assert.throws(()=>prepareCups(JSON.stringify(source())),/hash mismatch/);
 assert.deepEqual(await readCupCatalog({}),[]);
 const p=await prepared(),{env,objects}=envOf(p);objects.set(p.objects[0].key,p.objects[0].text+' ');
 assert.equal((await cupResponse(env,config.competitions[0].id,{})).status,503);
 const bad={...p.catalog,competitions:[{...p.catalog.competitions[0],id:'af:competition:9999'}]};objects.set(p.catalogKey,JSON.stringify(bad));
 await assert.rejects(readCupCatalog(env),/identity invalid/);
});
test('cup public routes preserve existing league directory if cup storage is unavailable',async()=>{
 const worker=(await import('../worker/index.mjs')).default;
 const env={APP_ORIGINS:'https://app.test',FOOTBALL_DB:{prepare:()=>({bind(){return this;},all:async()=>({results:[]})})},FOOTBALL_DATA:{get:async()=>null}};
 const r=await worker.fetch(new Request('https://api.test/api/v2/competitions',{headers:{origin:'https://app.test'}}),env,{});
 assert.equal(r.status,200);assert.deepEqual((await r.json()).competitions,[]);
});

test('periodic cup refresh retains all acquired matches and rejects identity loss before publication',async()=>{
 const {assertCupRefresh}=await import('../scripts/cups/refresh.mjs');
 const p=await prepared(),previous=p.objects.map(o=>JSON.parse(o.text));
 assert.doesNotThrow(()=>assertCupRefresh(previous,p));
 const changed=structuredClone(p);const value=JSON.parse(changed.objects[0].text);value.fixtures=[];changed.objects[0].text=JSON.stringify(value);
 assert.throws(()=>assertCupRefresh(previous,changed),/lost a stored fixture/);
 const moved=structuredClone(p),row=JSON.parse(moved.objects[0].text);row.fixtures[0].teams.home.id='af:team:999';moved.objects[0].text=JSON.stringify(row);
 assert.throws(()=>assertCupRefresh(previous,moved),/changed fixture identity/);
});

test('the global stored daily feed includes cup ties that have not received a core detail row',async()=>{
 const worker=(await import('../worker/index.mjs')).default;
 const p=await prepared(),{env,objects}=envOf(p);
 objects.set('football/v2/indexes/date-jst/2026-10-21.json',JSON.stringify({contractVersion:'2.0.0',timeZone:'Asia/Tokyo',date:'2026-10-21',fixtures:[],generatedAt:p.catalog.generatedAt}));
 env.APP_ORIGINS='https://app.test';env.LIVE_COMPETITION_IDS='2,3,848,48';
 env.FOOTBALL_DB={prepare:()=>({bind(){return this;},all:async()=>({results:[]})})};
 const response=await worker.fetch(new Request('https://api.test/api/v2/dates/2026-10-21',{headers:{origin:'https://app.test'}}),env,{});
 assert.equal(response.status,200);
 const feed=await response.json();assert.equal(feed.fixtures.length,14);assert.ok(feed.fixtures.some(f=>f.competitionId==='af:competition:848'));
 const {assertValidDateIndexPayload}=await import('../shared/date-index-contract.mjs');
 assert.doesNotThrow(()=>assertValidDateIndexPayload(feed,{expectedDate:'2026-10-21',expectedCompetitionId:null}));
});

test('cup preparation repairs an absent standings ID from archived provider teams without inventing or discarding rows',async()=>{
 const {prepareCups}=await import('../scripts/cups/prepare.mjs');
 const snapshot=source(),cup=snapshot.cups[0],id=cup.metadata.league.id;
 const scope={played:3,win:1,draw:0,lose:2,goals:{for:3,against:6}};
 cup.standings=[{league:{id,season:2026,name:cup.metadata.league.name,country:'World',standings:[[
  {rank:25,team:{id:null,name:'Sabah FC',logo:null},points:3,goalsDiff:-3,all:scope,home:scope,away:scope}
 ]]}}];
 cup.standingsTeams=[{id:9876,name:'Sabah FC'}];
 const raw=JSON.stringify(snapshot),prepared=prepareCups(raw,{source:{snapshotSha256:createHash('sha256').update(raw).digest('hex')}});
 const standings=JSON.parse(prepared.objects[0].text).standings;
 assert.equal(standings.groups[0].table[0].team.id,'af:team:9876');
 assert.equal(standings.groups[0].table[0].points,3);
 assert.equal(standings.groups[0].table[0].rank,25);
 assert.equal(prepared.objects.length,14);
});
