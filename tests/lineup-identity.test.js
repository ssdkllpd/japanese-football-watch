'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reconcileDuplicateLineupEntries}=require('../scripts/d1/lineup-identity');
const {normalizeFixtureBundle}=require('../scripts/d1/fixture-shadow-compare');
const captured=require('./fixtures/duplicate-provider-lineup-1554413.json');

test('captured repeated provider ID has one canonical entry and an explicitly unknown conflicting number',()=>{
 const original=JSON.stringify(captured),{bundle,report}=reconcileDuplicateLineupEntries(captured);
 const entries=bundle.lineups.flatMap(l=>l.substitutes).filter(p=>p.id==='af:player:619640');
 assert.equal(entries.length,1);assert.equal(entries[0].number,null);
 assert.deepEqual(report[0].sourceNumbers,[44,66]);
 assert.equal(bundle.lineups[0].fieldStates['substitutes[af:player:619640].number'].presence,'provider_missing');
 assert.equal(JSON.stringify(captured),original,'source evidence must remain untouched');
 const normalized=normalizeFixtureBundle(captured);
 assert.deepEqual(normalizeFixtureBundle(normalized),normalized,'canonicalization must be idempotent');
});

test('ambiguous repeated IDs never choose a name, role, or team by array order',()=>{
 for(const kind of ['name','role','team']){
  const source=structuredClone(captured),home=source.lineups[0];
  const indexes=home.substitutes.flatMap((p,i)=>p.id==='af:player:619640'?[i]:[]);
  const second=home.substitutes[indexes[1]];
  if(kind==='name')second.name='A different player';
  if(kind==='role'){home.substitutes.splice(indexes[1],1);home.startXI.push({...second,role:'starter'});}
  if(kind==='team'){home.substitutes.splice(indexes[1],1);source.lineups[1].substitutes.push(second);}
  const result=reconcileDuplicateLineupEntries(source);
  assert.equal(result.report.length,1);
  assert.equal(result.report[0].reason,'ambiguous_provider_lineup_identity');
  assert.equal(result.report[0].sourceEntries.length,2);
  assert.equal(result.bundle.lineups.flatMap(l=>[...l.startXI,...l.substitutes]).filter(p=>p.id==='af:player:619640').length,0);
 }
});

// Captured from the public R2 fallback for fixture 1646905 on 2026-11-08.
// Actions run 42530573240 rejected this exact goalkeeper/defender collision.
test('captured goalkeeper/bench defender conflict preserves the match without invented attribution',()=>{
 const source=require('./fixtures/provider-conflicting-roles-1646905.json'),original=JSON.stringify(source);
 const {bundle,report}=reconcileDuplicateLineupEntries(source);
 const issue=report.find(row=>row.playerId==='af:player:17911');
 assert.equal(issue.reason,'ambiguous_provider_lineup_identity');
 assert.deepEqual(issue.sourceEntries.map(p=>[p.listRole,p.position,p.number]),[['startXI','G',1],['substitutes','D',2]]);
 assert.equal(bundle.lineups[1].startXI.length,10);
 assert.equal(bundle.lineups[1].substitutes.length,8);
 assert.equal(bundle.lineups[1].fieldStates.startXI.presence,'provider_missing');
 assert.equal(bundle.lineups[1].fieldStates.substitutes.presence,'provider_missing');
 assert.deepEqual(bundle.lineups[0],source.lineups[0]);
 assert.deepEqual(bundle.fixture,source.fixture);
 assert.equal(bundle.events.length,source.events.length);
 assert.equal(JSON.stringify(source),original);
 assert.deepEqual(normalizeFixtureBundle(bundle),normalizeFixtureBundle(source));
 assert.deepEqual(reconcileDuplicateLineupEntries(bundle).bundle,bundle);
});

test('ambiguous identity cannot leak into statistics, events, or starter inference',()=>{
 const source=structuredClone(require('./fixtures/provider-conflicting-roles-1646905.json'));
 const id='af:player:17911';
 source.playerStats.push({playerId:id,teamId:source.lineups[1].teamId,starter:true,values:{goals:2}});
 source.events.push({id:'conflicted-goal',type:'goal',playerId:id,playerName:'J. Gibbons',relatedPlayerId:id,relatedPlayerName:'J. Gibbons'});
 const {bundle,report}=reconcileDuplicateLineupEntries(source);
 assert.equal(bundle.playerStats.some(row=>row.playerId===id),false);
 assert.equal(bundle.sectionStates.playerStats.presence,'provider_missing');
 assert.equal(bundle.events.at(-1).playerId,null);
 assert.equal(bundle.events.at(-1).relatedPlayerId,null);
 assert.equal(Object.hasOwn(bundle.events.at(-1),'playerName'),false);
 const issue=report.find(row=>row.playerId===id);
 assert.deepEqual(issue.sourceStats,source.playerStats.filter(row=>row.playerId===id));
 assert.equal(issue.sourceEvents.at(-1).playerId,id);
 assert.deepEqual(normalizeFixtureBundle(bundle),normalizeFixtureBundle(source));
});

test('manual indexed corrections keep cross-role collisions blocked for explicit review',()=>{
 const source=structuredClone(require('./fixtures/provider-conflicting-roles-1646905.json'));
 source.overrides={'lineups.1.startXI.0.number':{value:1}};
 const {bundle,report}=reconcileDuplicateLineupEntries(source);
 assert.equal(report.length,0);
 assert.deepEqual(bundle,source);
});

test('indexed lineup corrections prevent implicit entry removal',()=>{
 const source=structuredClone(captured);source.overrides={'lineups.0.substitutes.1.number':{value:44}};
 assert.equal(reconcileDuplicateLineupEntries(source).report.length,0);
});


test('unnamed trialist slots never become a person or a self-substitution',()=>{
 const source=require('./fixtures/provider-trialist-1548116.json'),original=JSON.stringify(source);
 const {bundle,report}=reconcileDuplicateLineupEntries(source);
 assert.equal(report[0].reason,'provider_unnamed_trialist_identity');
 assert.equal(report[0].sourceCount,2);assert.equal(report[0].eventReferences,2);
 assert.equal(bundle.lineups.flatMap(l=>[...l.startXI,...l.substitutes]).some(p=>p.id==='af:player:182419'),false);
 const lineup=bundle.lineups.find(l=>l.teamId==='af:team:6781');
 assert.equal(lineup.fieldStates.startXI.presence,'provider_missing');
 assert.equal(lineup.fieldStates.substitutes.presence,'provider_missing');
 assert.equal(bundle.events[0].playerId,null);assert.equal(bundle.events[0].relatedPlayerId,null);
 assert.equal(bundle.events.length,source.events.length);
 assert.deepEqual(normalizeFixtureBundle(bundle),normalizeFixtureBundle(source));
 assert.equal(JSON.stringify(source),original);
});

test('named players and manually corrected identities are never discarded as trialists',()=>{
 for(const kind of ['named','stats','correction']){
  const source=structuredClone(require('./fixtures/provider-trialist-1548116.json'));
  if(kind==='named')source.lineups[0].substitutes.find(p=>p.id==='af:player:182419').name='A real named player';
  if(kind==='stats')source.playerStats.push({playerId:'af:player:182419'});
  if(kind==='correction')source.overrides={'events.0.playerId':{value:'af:player:182419'}};
  const {report}=reconcileDuplicateLineupEntries(source);
  if(kind==='correction')assert.equal(report.length,0);
  else {
   assert.equal(report.length,1);
   assert.equal(report[0].reason,'ambiguous_provider_lineup_identity');
   assert.equal(report[0].sourceEntries.length,2);
  }
 }
});


test('provider trialist letter labels on either side remain unresolved across teams',()=>{
 const source=require('./fixtures/provider-trialist-1548126.json');
 const {bundle,report}=reconcileDuplicateLineupEntries(source);
 assert.equal(report[0].sourceCount,2);assert.equal(report[0].eventReferences,2);
 assert.equal(bundle.lineups.flatMap(l=>[...l.startXI,...l.substitutes]).some(p=>p.id==='af:player:182419'),false);
 for(const e of bundle.events)assert.equal([e.playerId,e.relatedPlayerId].includes('af:player:182419'),false);
 for(const l of bundle.lineups)assert.equal(l.fieldStates.substitutes.presence,'provider_missing');
 assert.deepEqual(normalizeFixtureBundle(bundle),normalizeFixtureBundle(source));
});
