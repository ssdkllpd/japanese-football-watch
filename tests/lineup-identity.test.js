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
