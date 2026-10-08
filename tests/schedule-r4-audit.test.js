// SCHED-R4 regression verification; independent expectations use explicit input identities/dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, baseline, update, drain, dateIndexR2Key, competitionDateIndexR2Key } from './helpers/schedule-r2-harness.mjs';
import { auditScheduleSync, affectedScheduleScopes } from '../scripts/d1/audit-fixture-schedule-sync.mjs';
import { SCHEDULE_INVENTORY_SQL } from '../scripts/d1/capture-schedule-audit.mjs';
import publicWorker from '../worker/index.mjs';

const A='2026-11-10',B='2026-11-11',C='2026-12-01',D='2026-12-02';
const checkpoint={fixture_id:'af:fixture:8503',old_date_jst:C,new_date_jst:D,registered_dates_json:JSON.stringify([C,D])};
async function evidence() {
  const ctx=setup([{id:8501,league:39,kickoff:`${A}T10:00:00.000Z`},
    {id:8502,league:39,kickoff:`${A}T12:00:00.000Z`},
    {id:8503,league:39,kickoff:`${C}T10:00:00.000Z`}]);
  await baseline(ctx,[A,B,C,D]);
  const rows=sql=>ctx.db.prepare(sql).all().map(row=>({...row}));
  const before=rows(SCHEDULE_INVENTORY_SQL);
  const change=update(8501,39,`${A}T10:00:00.000Z`,`${B}T10:00:00.000Z`);
  assert.equal((await ctx.send(change)).status,200);assert.equal((await drain(ctx)).status,200);
  const after=rows(SCHEDULE_INVENTORY_SQL), r2={},publicSamples=[];
  for(const [key,scope] of affectedScheduleScopes([change],before,after)) {
    r2[key]=JSON.parse(ctx.objects.get(scope.competitionId?competitionDateIndexR2Key(scope.competitionId,scope.date):dateIndexR2Key(scope.date)));
    const route=scope.competitionId?`/api/v2/competitions/${encodeURIComponent(scope.competitionId)}/dates/${scope.date}`:`/api/v2/dates/${scope.date}`;
    const res=await publicWorker.fetch(new Request(`https://worker.test${route}?fresh=1`,{
      headers:{Origin:'https://app.test','x-jfw-audit-token':'a'.repeat(32)}}),{
      ...ctx.env,APP_ORIGINS:'https://app.test',PUBLIC_DATE_AUDIT_TOKEN:'a'.repeat(32),
      D1_DATE_INDEX_ENABLED:'true',D1_COMPETITION_DATE_INDEX_ENABLED:'true'});
    publicSamples.push({scope:key,status:res.status,payload:await res.json()});
  }
  const data={changes:[change],before,after,inventoryEnd:after,pending:[],dateRepairs:[],r2,publicSamples,
    genericCoverages:rows('SELECT date_jst,fixture_count,fixture_id_digest FROM date_index_coverages'),
    competitionCoverages:rows('SELECT c.canonical_id AS competition_id,v.date_jst,v.fixture_count,v.fixture_id_digest FROM competition_date_index_coverages v JOIN competitions c ON c.id=v.competition_id')};
  ctx.db.close();return data;
}

test('R4 audit verifies real affected-date payloads while listing unrelated repairs as an overall failure',async()=>{
  const data=await evidence();
  const clean=auditScheduleSync(data);assert.equal(clean.overallPassed,true);
  const queue={date_jst:C,repair_token:'isolated',last_error:'Investigate orphan'};
  const result=auditScheduleSync({...data,pending:[checkpoint],dateRepairs:[queue]});
  assert.equal(result.passed,true);assert.equal(result.overallPassed,false);
  assert.equal(result.verifiedChanges,1);assert.equal(result.verifiedPreservedFixtures,2);
  assert.equal(result.verifiedR2Scopes,4);assert.equal(result.verifiedPublicSamples,4);
  assert.deepEqual(result.isolatedDateRepairs,[{stage:'initial',...queue},{stage:'final',...queue}]);
  assert.deepEqual(result.isolatedPendingRepairs,[{stage:'initial',...checkpoint},{stage:'final',...checkpoint}]);
});
test('R4 old/new affected dates, selected fixture, current fixture date and registered intermediate dates still block',async()=>{
  const data=await evidence();
  for(const date of [A,B]) assert.throws(()=>auditScheduleSync({...data,dateRepairs:[{date_jst:date}]}),/Affected date/);
  for(const pending of [
    {...checkpoint,fixture_id:'af:fixture:8501'},
    {...checkpoint,fixture_id:'af:fixture:8502'},
    {...checkpoint,old_date_jst:A},
    {...checkpoint,new_date_jst:B},
    {...checkpoint,registered_dates_json:JSON.stringify([C,B])}
  ]) assert.throws(()=>auditScheduleSync({...data,pending:[pending]}),/repair remains pending/);
});
test('R4 repair evidence collected at audit end is checked and unrelated generation changes are reported',async()=>{
  const data=await evidence();
  assert.throws(()=>auditScheduleSync({...data,dateRepairsEnd:[{date_jst:B}]}),/Affected date/);
  assert.throws(()=>auditScheduleSync({...data,pendingEnd:[{...checkpoint,registered_dates_json:JSON.stringify([A])}]}),/repair remains pending/);
  const result=auditScheduleSync({...data,dateRepairs:[{date_jst:C,repair_token:'old'}],
    dateRepairsEnd:[{date_jst:D,repair_token:'new'}]});
  assert.equal(result.passed,true);assert.equal(result.overallPassed,false);
  assert.deepEqual(result.isolatedDateRepairs,[{stage:'initial',date_jst:C,repair_token:'old'},
    {stage:'final',date_jst:D,repair_token:'new'}]);
});
test('R4 isolation does not bypass payload, public sample or preserved-fixture checks',async()=>{
  const data=await evidence();data.dateRepairs=[{date_jst:C}];
  const changed=structuredClone(data);changed.r2[`all/${B}`].fixtures[0].status.long='Tampered';
  assert.throws(()=>auditScheduleSync(changed),/R2.*differs from D1/);
  assert.throws(()=>auditScheduleSync({...data,publicSamples:[]}),/Public Worker samples/);
  const preserved=structuredClone(data);
  for(const rows of [preserved.after,preserved.inventoryEnd]) rows.find(row=>row.fixture_id==='af:fixture:8503').status_long='Tampered';
  assert.throws(()=>auditScheduleSync(preserved),/Unselected or held fixture/);
});
test('R4 incomplete or malformed repair evidence cannot be silently classified as unrelated',async()=>{
  const data=await evidence();
  for(const row of [{date_jst:'2026-02-30'},{date_jst:null},null])
    assert.throws(()=>auditScheduleSync({...data,dateRepairs:[row]}),/evidence is invalid/);
  for(const row of [{fixture_id:'af:fixture:8503'},
    {...checkpoint,registered_dates_json:'broken'},
    {...checkpoint,registered_dates_json:JSON.stringify(['2026-02-30'])}])
    assert.throws(()=>auditScheduleSync({...data,pending:[row]}),/evidence is invalid/);
});
