'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const league=(id,name,country='World',standings=true)=>({league:{id,name,type:'Cup'},country:{name:country},seasons:[{year:2026,coverage:{standings}}]});
const rows=response=>({data:{response,results:response.length,paging:{total:1}}});
const database={prepare:()=>({all:async()=>({results:[{competitionId:'af:competition:2',fixtures:3}]})})};
test('cup inspection selects exact countries and names, keeps stored counts and only requests supported standings',async()=>{
 const {inspectCups,summarize}=await import('../scripts/cups/inspect.mjs');const calls=[];
 const client={refreshDailyQuota:async()=>({dailyRemaining:1300}),lastQuota:{dailyRemaining:1290},get:async(endpoint,params)=>{
  calls.push([endpoint,params]);
  if(endpoint==='leagues')return rows([league(2,'UEFA Champions League'),league(48,'League Cup','England',false),league(999,'League Cup','Finland')]);
  if(endpoint==='standings')return rows([{league:{standings:[[]]}}]);
  return rows(params.league===2?[{fixture:{id:100},league:{id:2,season:2026},teams:{home:{id:1},away:{id:2}}}]:[]);
 }};
 const snapshot=await inspectCups({client,database});const summary=summarize(snapshot);
 assert.equal(summary.stored[0].fixtures,3);assert.equal(summary.cups.find(c=>c.id===2).fixtures,1);
 assert.equal(summary.cups.find(c=>c.id===48).status,'fixtures_not_yet_available');
 assert.equal(summary.cups.some(c=>c.id===999),false);
 assert.deepEqual(calls.filter(c=>c[0]==='standings').map(c=>c[1].league),[2]);
 assert.equal(summary.cups.find(c=>c.name==='UEFA Europa League').status,'season_not_available');
});
test('cup inspection stops before provider discovery when live reserve cannot be protected',async()=>{
 const {inspectCups}=await import('../scripts/cups/inspect.mjs');
 await assert.rejects(inspectCups({client:{refreshDailyQuota:async()=>({dailyRemaining:1249}),get:()=>assert.fail('provider called')},database}),/preserve 1200/);
});
test('cup inspection rejects duplicates and cross-competition fixture responses',async()=>{
 const {inspectCups}=await import('../scripts/cups/inspect.mjs');
 for(const fixtures of [[{fixture:{id:1},league:{id:3,season:2026}}],Array(2).fill({fixture:{id:1},league:{id:2,season:2026}})]){
  const client={refreshDailyQuota:async()=>({dailyRemaining:1300}),get:async endpoint=>rows(endpoint==='leagues'?[league(2,'UEFA Champions League')]:fixtures)};
  await assert.rejects(inspectCups({client,database}),/fixture identity/);
 }
});
