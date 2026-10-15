// SCHED-R3 regression verification; this is not an independent review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, baseline, update, dateIndexR2Key, r2Ids, countD1 } from './helpers/schedule-r2-harness.mjs';
import { drainDateRepairs } from '../scripts/d1/drain-date-repairs.mjs';
import { executeSchedulePlan } from '../scripts/d1/execute-fixture-schedule-plan.mjs';
import { sha256Text } from '../admin-worker/date-repair-control.mjs';
import publicWorker from '../worker/index.mjs';

const A='2026-12-01', B='2026-12-02', C='2026-12-03';
const sender=ctx=>async input=>{
  const result=await ctx.send(input);
  if(result.status!==200) throw new Error(result.body.detail);
  return result.body.report;
};
async function poison() {
  const ctx=setup([{id:7001,league:39,kickoff:`${A}T10:00:00.000Z`},
    {id:7002,league:39,kickoff:`${B}T10:00:00.000Z`}]);
  await baseline(ctx,[A,B,C]);
  const old=JSON.parse(ctx.objects.get(dateIndexR2Key(A)));
  old.fixtures.push({...old.fixtures[0],fixtureId:'af:fixture:99999'});
  ctx.objects.set(dateIndexR2Key(A),JSON.stringify(old));
  assert.equal((await ctx.send(update(7001,39,`${A}T10:00:00.000Z`,`${A}T11:00:00.000Z`))).status,200);
  return ctx;
}
test('R3 poison pending fixture does not block an unrelated real schedule execution',async()=>{
  const ctx=await poison();
  const report=await executeSchedulePlan({schemaVersion:'jfw-fixture-schedule-plan/1',changes:[
    {schemaVersion:'jfw-d1-admin-ingest/1',...update(7002,39,`${B}T10:00:00.000Z`,`${C}T10:00:00.000Z`)}
  ]},sender(ctx),{capacityCheck:async()=>{}});
  assert.equal(report.passed,true,JSON.stringify(report));
  assert.deepEqual(r2Ids(ctx,dateIndexR2Key(B)),[]);
  assert.deepEqual(r2Ids(ctx,dateIndexR2Key(C)),['af:fixture:7002']);
  assert.deepEqual(ctx.db.prepare('SELECT date_jst FROM date_index_repair_queue').all().map(r=>r.date_jst),[A]);
  assert.equal(ctx.db.prepare('SELECT count(*) n FROM fixture_schedule_refresh_pending').get().n,1);
});
test('R3 global drain records failure, continues healthy work, and protected recovery retains evidence',async()=>{
  const ctx=await poison();
  ctx.db.prepare("UPDATE fixtures SET status_short='PST' WHERE canonical_id='af:fixture:7002'").run();
  const drained=await drainDateRepairs(sender(ctx));
  assert.equal(drained.passed,false);assert.equal(drained.remaining,1);
  assert.deepEqual(drained.failures.map(r=>r.date),[A]);
  assert.deepEqual(drained.repairedDates,[B]);
  const status=await sender(ctx)({operation:'fixture_schedule_repair_status'});
  assert.match(status.dates[0].last_error,/absent|missing|lost/i);
  const raw=ctx.objects.get(dateIndexR2Key(A));
  const request={operation:'date_index_repair_authorize',date:A,
    expectedRepairToken:status.dates[0].repair_token,sourceSha256:await sha256Text(raw),
    orphanFixtureIds:['af:fixture:99999'],allowInvalidPrevious:false,
    reason:'R2 orphan independently confirmed absent from the D1 inventory.'};
  assert.equal((await ctx.send({...request,expectedRepairToken:'stale'})).status,422);
  assert.equal((await ctx.send({...request,sourceSha256:'0'.repeat(64)})).status,422);
  assert.equal((await ctx.send({...request,orphanFixtureIds:['af:fixture:7001']})).status,422);
  assert.equal(ctx.db.prepare('SELECT count(*) n FROM date_index_repair_authorizations').get().n,0);
  const approved=await ctx.send(request);assert.equal(approved.status,200,JSON.stringify(approved));
  assert.equal(ctx.objects.get(approved.body.report.evidenceKey),raw);
  assert.equal(ctx.db.prepare('SELECT count(*) n FROM date_index_repair_queue').get().n,1,'approval never deletes journal');
  const repaired=await drainDateRepairs(sender(ctx),{dates:[A]});
  assert.equal(repaired.passed,true,JSON.stringify(repaired));
  assert.deepEqual(r2Ids(ctx,dateIndexR2Key(A)),['af:fixture:7001']);
  assert.equal(ctx.db.prepare('SELECT count(*) n FROM fixture_schedule_refresh_pending').get().n,0);
});
test('R3 explicit invalid-contract approval permits rebuild, but changing evidence revokes it',async()=>{
  const ctx=setup([{id:7003,league:39,kickoff:`${A}T10:00:00.000Z`}]);
  await baseline(ctx,[A]);ctx.objects.set(dateIndexR2Key(A),'invalid JSON');
  const queued=await ctx.send({operation:'date_index_repair_enqueue',date:A,reason:'Periodic reconciliation detected an invalid stored index.'});
  const request={operation:'date_index_repair_authorize',date:A,expectedRepairToken:queued.body.report.repairToken,
    sourceSha256:await sha256Text('invalid JSON'),orphanFixtureIds:[],allowInvalidPrevious:false,
    reason:'Archived index is malformed; D1 inventory has been verified.'};
  assert.equal((await ctx.send(request)).status,422);
  assert.equal((await ctx.send({...request,allowInvalidPrevious:true})).status,200);
  ctx.objects.set(dateIndexR2Key(A),'different invalid JSON');
  assert.equal((await ctx.send({operation:'fixture_schedule_repair',date:A})).status,422,'approval is bound to exact evidence');
  ctx.objects.set(dateIndexR2Key(A),'invalid JSON');
  assert.equal((await drainDateRepairs(sender(ctx),{dates:[A]})).passed,true);
  assert.deepEqual(r2Ids(ctx,dateIndexR2Key(A)),['af:fixture:7003']);
});
test('R3 historical empty scopes do not accumulate beyond the 24 active-scope limit; millisecond-free kickoff normalizes',async()=>{
  const ctx=setup([{id:7004,league:39,kickoff:`${A}T10:00:00Z`}]);
  await baseline(ctx,[A]);
  for(let i=100;i<125;i++) ctx.db.exec(`INSERT INTO competitions(id,canonical_id,source_id,provider_id,name,country_name,type)
    VALUES(${i},'af:competition:${i}',1,${i},'Old ${i}','England','League');
    INSERT INTO competition_date_index_coverages(competition_id,date_jst,fixture_count,fixture_id_digest,generated_at,source_r2_key,source_sha256)
    SELECT ${i},date_jst,0,fixture_id_digest,generated_at,source_r2_key,source_sha256 FROM competition_date_index_coverages WHERE competition_id=1 AND date_jst='${A}'`);
  const queued=await ctx.send({operation:'date_index_repair_enqueue',date:A,reason:'Verify normalization and historical empty coverage cleanup.'});
  assert.equal(queued.status,200);
  const counter=countD1(ctx);
  const repair=await ctx.send({operation:'fixture_schedule_repair',date:A});counter.restore();
  assert.equal(repair.status,200,JSON.stringify(repair));
  assert.ok(counter.single+counter.batches<50,JSON.stringify(counter));
  assert.equal(JSON.parse(ctx.objects.get(dateIndexR2Key(A))).fixtures[0].kickoffUtc,`${A}T10:00:00.000Z`);
});
test('R3 audit bypass rejects unauthorized reads before D1 and accepts dedicated credentials on both routes',async()=>{
  const ctx=setup([{id:7005,league:39,kickoff:`${A}T10:00:00.000Z`}]);await baseline(ctx,[A]);
  const env={...ctx.env,APP_ORIGINS:'https://app.test',D1_DATE_INDEX_ENABLED:'true',D1_COMPETITION_DATE_INDEX_ENABLED:'true',PUBLIC_DATE_AUDIT_TOKEN:'a'.repeat(32)};
  for(const route of [`/api/v2/dates/${A}`,`/api/v2/competitions/af:competition:39/dates/${A}`]) {
    const counter=countD1(ctx);
    for(const token of [null,'wrong']) {
      const response=await publicWorker.fetch(new Request(`https://worker.test${route}?fresh=1`,{headers:{Origin:'https://app.test',...(token?{'x-jfw-audit-token':token}:{})}}),env);
      assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');
    }
    assert.equal(counter.single+counter.batches,0);counter.restore();
    const response=await publicWorker.fetch(new Request(`https://worker.test${route}?fresh=1`,{headers:{Origin:'https://app.test','x-jfw-audit-token':env.PUBLIC_DATE_AUDIT_TOKEN}}),env);
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  }
});
