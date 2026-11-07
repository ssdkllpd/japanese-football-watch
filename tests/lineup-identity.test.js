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

test('repeated IDs with distinct names, roles, or teams remain unresolved',()=>{
 for(const kind of ['name','role','team']){
  const source=structuredClone(captured),home=source.lineups[0];
  const indexes=home.substitutes.flatMap((p,i)=>p.id==='af:player:619640'?[i]:[]);
  const second=home.substitutes[indexes[1]];
  if(kind==='name')second.name='A different player';
  if(kind==='role'){home.substitutes.splice(indexes[1],1);home.startXI.push({...second,role:'starter'});}
  if(kind==='team'){home.substitutes.splice(indexes[1],1);source.lineups[1].substitutes.push(second);}
  const result=reconcileDuplicateLineupEntries(source);
  assert.equal(result.report.length,0);
  assert.equal(result.bundle.lineups.flatMap(l=>[...l.startXI,...l.substitutes]).filter(p=>p.id==='af:player:619640').length,2);
 }
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
  assert.equal(reconcileDuplicateLineupEntries(source).report.length,0);
 }
});
