// Adapted regression tests; these results are not an independent review.
// Re-review (PR #123 b77d9cb): Admin schedule update / repair / publication interplay on real SQLite.
// Independent expectations are written from the literal inputs of each test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  ROOT, drain, setup, baseline, update, r2Ids, r2Payload, feedOrError, pendingRows, fixtureRow, coverage,
  dateIndexR2Key, competitionDateIndexR2Key, finalBundle, tmpRoot, adminFetch, createAutomationAdminPlan, countD1,
} from './helpers/schedule-r2-harness.mjs';

const require = createRequire(import.meta.url);
const { executeAutomationAdminPlan } = await import(path.join(ROOT, 'scripts/d1/execute-automation-admin-plan.mjs'));
const G = dateIndexR2Key;
const C = (league, date) => competitionDateIndexR2Key(`af:competition:${league}`, date);
const F = id => `af:fixture:${id}`;
const REPAIR = { operation: 'fixture_schedule_repair' };

async function publish(ctx, id, league, kickoff, previousDateJst, tag) {
  const root = tmpRoot(tag);
  finalBundle(ctx, root, id, league, kickoff);
  const plan = createAutomationAdminPlan({ schemaVersion: 'jfw-api-football-automation-plan/1',
    detailFetches: [{ providerFixtureId: id, fixtureId: F(id), competitionId: `af:competition:${league}`,
      seasonId: `af:season:${league}:2026`, ...(previousDateJst ? { previousDateJst } : {}) }], standingsFetches: [] },
  root, path.join(root, 'd1'));
  const rejects = [];
  const report = await executeAutomationAdminPlan(plan, { url: 'https://offline.test', token: 't',
    planDirectory: path.join(root, 'd1'), fetchImpl: async (u, i) => { const r = await adminFetch(ctx)(u, i);
      if (!r.ok) rejects.push((await r.clone().json()).detail); return r; } });
  return { passed: report.passed, successful: report.successfulFixtures, rejects };
}
const state3 = async (ctx, dates, league = 39) => Object.fromEntries(await Promise.all(dates.map(async d => [d, {
  r2: r2Ids(ctx, G(d)), r2c: r2Ids(ctx, C(league, d)), cov: coverage(ctx, d), feed: (await feedOrError(ctx, d)).ids ?? (await feedOrError(ctx, d)).error ?? null }])));

test('N01 A->B pending (repair never ran), then the result relocates B->C through the real publish path', async () => {
  const [A, B, Cd] = ['2026-10-03', '2026-10-04', '2026-10-05'];
  const ctx = setup([{ id: 4001, league: 39, kickoff: `${A}T10:00:00.000Z` }, { id: 4002, league: 39, kickoff: `${A}T12:00:00.000Z` }]);
  await baseline(ctx, [A, B, Cd]);
  assert.equal((await ctx.send(update(4001, 39, `${A}T10:00:00.000Z`, `${B}T10:00:00.000Z`))).status, 200);
  const out = await publish(ctx, 4001, 39, `${Cd}T10:00:00.000Z`, B, 'n01');
  const st = await state3(ctx, [A, B, Cd]);
  console.log('N01 evidence', JSON.stringify({ out, row: fixtureRow(ctx, 4001), pending: pendingRows(ctx), st }));
  assert.equal(out.passed, true);
  assert.deepEqual(pendingRows(ctx), []);
  assert.deepEqual([st[A].r2, st[B].r2, st[Cd].r2], [[F(4002)], [], [F(4001)]]);
  assert.deepEqual([st[A].r2c, st[B].r2c, st[Cd].r2c], [[F(4002)], [], [F(4001)]]);
  assert.deepEqual([st[A].feed, st[B].feed, st[Cd].feed], [[F(4002)], [], [F(4001)]]);
  assert.deepEqual([st[A].cov.generic, st[B].cov.generic, st[Cd].cov.generic], [1, 0, 1]);
});

test('N02 the publish-time drain hits an R2 failure: D1 fixture must stay unpublished, retry converges', async () => {
  const [A, B] = ['2026-10-03', '2026-10-04'];
  for (const failing of [G(A), C(39, A), G(B), C(39, B)]) {
    const ctx = setup([{ id: 4101, league: 39, kickoff: `${A}T10:00:00.000Z` }]);
    await baseline(ctx, [A, B]);
    assert.equal((await ctx.send(update(4101, 39, `${A}T10:00:00.000Z`, `${B}T10:00:00.000Z`))).status, 200);
    ctx.faults.failPutKeys.add(failing);
    const first = await publish(ctx, 4101, 39, `${B}T10:00:00.000Z`, null, 'n02a');
    assert.equal(first.passed, false, failing);
    assert.equal(fixtureRow(ctx, 4101).published_revision, null, 'publication must not proceed past a failed repair');
    assert.equal(pendingRows(ctx).length, 1);
    const second = await publish(ctx, 4101, 39, `${B}T10:00:00.000Z`, null, 'n02b');
    assert.equal(second.passed, true, JSON.stringify(second));
    assert.deepEqual(pendingRows(ctx), []);
    assert.deepEqual([r2Ids(ctx, G(A)), r2Ids(ctx, G(B)), r2Ids(ctx, C(39, A)), r2Ids(ctx, C(39, B))], [[], [F(4101)], [], [F(4101)]]);
  }
});

test('N03 [INTERLEAVED] result moves B->C while the A->B repair is between its D1 read and its R2 writes', async () => {
  const [A, B, Cd] = ['2026-10-03', '2026-10-04', '2026-10-05'];
  const ctx = setup([{ id: 4201, league: 39, kickoff: `${A}T10:00:00.000Z` }]);
  await baseline(ctx, [A, B, Cd]);
  assert.equal((await ctx.send(update(4201, 39, `${A}T10:00:00.000Z`, `${B}T10:00:00.000Z`))).status, 200);
  assert.equal((await ctx.send(REPAIR)).status,200); // complete A; next invocation repairs B
  const realPut = ctx.env.FOOTBALL_DATA.put; let fired = false; let inner = null;
  ctx.env.FOOTBALL_DATA.put = async (key, value) => {
    if (!fired && key === G(B)) { fired = true; inner = await publish(ctx, 4201, 39, `${Cd}T10:00:00.000Z`, B, 'n03'); }
    return realPut(key, value);
  };
  const outer = await ctx.send(REPAIR);
  ctx.env.FOOTBALL_DATA.put = realPut;
  const later = []; for (let i = 0; i < 100; i += 1) { const result=await ctx.send(REPAIR);assert.equal(result.status,200,JSON.stringify(result));later.push(result.body.report?.repaired ?? 'none');if(result.body.report?.repaired===null) break; }
  const st = await state3(ctx, [A, B, Cd]);
  console.log('N03 evidence', JSON.stringify({ outer: [outer.status, outer.body.detail], inner, later, row: fixtureRow(ctx, 4201), pending: pendingRows(ctx), st }));
  // Independent expectation: every store agrees the fixture is only on C, or a pending marker remains to finish the job.
  const converged = JSON.stringify([st[A].r2, st[B].r2, st[Cd].r2]) === JSON.stringify([[], [], [F(4201)]])
    && JSON.stringify([st[A].r2c, st[B].r2c, st[Cd].r2c]) === JSON.stringify([[], [], [F(4201)]]);
  assert.equal(inner.passed,true);
  assert.ok(converged,'all three dates must converge after draining actual requests');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM date_index_repair_queue').get().n,0);
});

test('N04 a stale repair finishing late must not delete a newer same-date checkpoint (repair_token)', async () => {
  const D = '2026-10-03';
  const ctx = setup([{ id: 4301, league: 39, kickoff: `${D}T10:00:00.000Z` }]);
  await baseline(ctx, [D]);
  assert.equal((await ctx.send(update(4301, 39, `${D}T10:00:00.000Z`, `${D}T11:00:00.000Z`))).status, 200); // token1
  const realPut = ctx.env.FOOTBALL_DATA.put; let fired = false; const mid = {};
  ctx.env.FOOTBALL_DATA.put = async (key, value) => {
    if (!fired && key === G(D)) { fired = true;
      mid.repair2 = (await drain(ctx)).status;                                                   // completes, deletes token1
      mid.update2 = (await ctx.send(update(4301, 39, `${D}T11:00:00.000Z`, `${D}T12:00:00.000Z`))).status; // token2, same dates
      mid.pendingAfterUpdate2 = pendingRows(ctx).length; }
    return realPut(key, value);                                                                         // stale write (11:00)
  };
  const stale = await ctx.send(REPAIR);
  ctx.env.FOOTBALL_DATA.put = realPut;
  const afterStale = { pending: pendingRows(ctx).length, r2: r2Payload(ctx, G(D)).fixtures.map(f => f.kickoffUtc) };
  const final = await ctx.send(REPAIR);
  const end = { pending: pendingRows(ctx).length, r2: r2Payload(ctx, G(D)).fixtures.map(f => f.kickoffUtc), d1: fixtureRow(ctx, 4301).kickoff_utc };
  console.log('N04 evidence', JSON.stringify({ mid, stale: [stale.status, stale.body.report?.repaired], afterStale, final: final.status, end }));
  assert.equal(afterStale.pending, 1, 'newer checkpoint must survive the stale repair');
  assert.deepEqual(end, { pending: 0, r2: [`${D}T12:00:00.000Z`], d1: `${D}T12:00:00.000Z` });
});

test('N05 legacy checkpoint (token "") written before migration 0010 can be drained and blocks new reservations until then', async () => {
  const [A, B] = ['2026-10-03', '2026-10-04'];
  const ctx = setup([{ id: 4401, league: 39, kickoff: `${A}T10:00:00.000Z` }, { id: 4402, league: 39, kickoff: `${A}T12:00:00.000Z` }]);
  await baseline(ctx, [A, B]);
  // What the pre-0010 Admin Worker left behind: D1 moved, checkpoint row with the DEFAULT '' token.
  ctx.db.exec(`UPDATE fixtures SET kickoff_utc='${B}T10:00:00.000Z', date_jst='${B}' WHERE canonical_id='af:fixture:4401';
    INSERT INTO fixture_schedule_refresh_pending(fixture_id,old_date_jst,new_date_jst,changed_at) VALUES('af:fixture:4401','${A}','${B}','2026-09-30T02:00:00.000Z');`);
  const blocked = await ctx.send(update(4402, 39, `${A}T12:00:00.000Z`, `${B}T12:00:00.000Z`));
  assert.equal(blocked.status, 422);
  assert.equal(fixtureRow(ctx, 4402).date_jst, A);
  assert.equal((await drain(ctx)).status, 200);
  assert.deepEqual(pendingRows(ctx), []);
  assert.deepEqual([r2Ids(ctx, G(A)), r2Ids(ctx, G(B))], [[F(4402)], [F(4401)]]);
});

test('N06 Admin Worker deployed before migration 0010 (no repair_token column)', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { createLocalD1 } = require(path.join(ROOT, 'scripts/d1/local-d1.js'));
  const { handleAdminIngest } = await import(path.join(ROOT, 'admin-worker/index.mjs'));
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(path.join(ROOT, 'migrations')).sort().filter(n => n < '0010')) db.exec(fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8'));
  db.exec(`INSERT INTO provider_sources(id,code,api_version) VALUES(1,'api-football','v3');
    INSERT INTO product_seasons(id,canonical_id,label,starts_on,ends_on) VALUES(1,'jfw:season:2026-27','2026-27','2026-07-01','2027-06-30');
    INSERT INTO competitions(id,canonical_id,source_id,provider_id,name,country_name,type) VALUES(1,'af:competition:39',1,39,'PL','England','League');
    INSERT INTO competition_seasons(id,canonical_id,competition_id,product_season_id,provider_season,label,status) VALUES(1,'af:season:39:2026',1,1,2026,'2026','active');
    INSERT INTO teams(id,canonical_id,source_id,provider_id,name) VALUES(1,'af:team:40',1,40,'H'),(2,'af:team:50',1,50,'A');
    INSERT INTO fixtures(canonical_id,source_id,provider_id,competition_season_id,home_team_id,away_team_id,kickoff_utc,date_jst,status_short,status_long,ingestion_state)
      VALUES('af:fixture:4501',1,4501,1,1,2,'2026-10-03T10:00:00.000Z','2026-10-03','NS','Not Started','scheduled');`);
  const env = { ADMIN_INGEST_TOKEN: 't', FOOTBALL_DB: createLocalD1(db), FOOTBALL_DATA: { async get() { return null; }, async put() {} } };
  const send = async p => { const r = await handleAdminIngest(new Request('https://offline.test/admin/v1/ingest', { method: 'POST',
    headers: { authorization: 'Bearer t' }, body: JSON.stringify({ schemaVersion: 'jfw-d1-admin-ingest/1', ...p }) }), env); return [r.status, (await r.json()).detail]; };
  const u = await send(update(4501, 39, '2026-10-03T10:00:00.000Z', '2026-10-04T10:00:00.000Z'));
  const r = await send(REPAIR);
  const row = { ...db.prepare("SELECT kickoff_utc FROM fixtures WHERE canonical_id='af:fixture:4501'").get() };
  console.log('N06 evidence', JSON.stringify({ update: u, repair: r, row }));
  // Fail-closed is acceptable; a partial write is not.
  assert.equal(u[0], 422); assert.equal(row.kickoff_utc, '2026-10-03T10:00:00.000Z');
});

test('N07 terminal / interrupted statuses propagate through the Admin update; final statuses are refused', async () => {
  const D = '2026-10-03';
  const ctx = setup([39, 39, 39, 39, 39, 39, 39].map((league, i) => ({ id: 4601 + i, league, kickoff: `${D}T0${i}:00:00.000Z` })));
  await baseline(ctx, [D]);
  const expected = { CANC: 'Cancelled', ABD: 'Abandoned', AWD: 'Technical Loss', WO: 'Walkover', SUSP: 'Match Suspended', INT: 'Match Interrupted' };
  let i = 0;
  for (const [status, long] of Object.entries(expected)) {
    const k = `${D}T0${i}:00:00.000Z`;
    assert.equal((await ctx.send(update(4601 + i, 39, k, k, 'NS', status))).status, 200, status);
    assert.equal((await drain(ctx)).status, 200);
    const row = ctx.db.prepare('SELECT status_short, status_long FROM fixtures WHERE canonical_id = ?').get(F(4601 + i));
    assert.deepEqual({ ...row }, { status_short: status, status_long: long });
    assert.equal(r2Payload(ctx, G(D)).fixtures.find(f => f.fixtureId === F(4601 + i)).status.short, status);
    i += 1;
  }
  const k6 = `${D}T06:00:00.000Z`;
  assert.equal((await ctx.send(update(4607, 39, k6, k6, 'NS', 'FT'))).status, 422);
  // reinstated: CANC -> NS on a new date
  assert.equal((await ctx.send(update(4601, 39, `${D}T00:00:00.000Z`, '2026-10-20T10:00:00.000Z', 'CANC', 'NS'))).status, 200);
  assert.equal((await drain(ctx)).status, 200);
  assert.equal(fixtureRow(ctx, 4601).date_jst, '2026-10-20');
  assert.deepEqual(pendingRows(ctx), []);
});

test('N08 stored kickoff without milliseconds', async () => {
  // (a) the date-index builder itself rejects such a row, so it cannot have a valid index today
  const pre = setup([{ id: 4700, league: 39, kickoff: '2026-10-03T10:00:00Z' }]);
  let builderError = null;
  try { await baseline(pre, ['2026-10-03']); } catch (e) { builderError = e.message; }
  // (b) the schedule update now accepts it and stores a normalized value
  const ctx = setup([{ id: 4701, league: 39, kickoff: '2026-10-03T10:00:00Z' }]);
  await baseline(ctx, ['2026-10-05']);
  const u = await ctx.send(update(4701, 39, '2026-10-03T10:00:00Z', '2026-10-05T10:00:00Z'));
  const r = await drain(ctx);
  console.log('N08 evidence', JSON.stringify({ builderError, update: u.status, repair: [r.status, r.body.detail], row: fixtureRow(ctx, 4701), r2New: r2Ids(ctx, G('2026-10-05')) }));
  assert.equal(u.status, 200); assert.equal(r.status, 200);
  assert.equal(fixtureRow(ctx, 4701).kickoff_utc, '2026-10-05T10:00:00.000Z');
  assert.deepEqual(r2Ids(ctx, G('2026-10-05')), [F(4701)]);
});

test('N09 residual wedge: the fixture leaves the checkpoint destination by a path other than fixture publication', async () => {
  const [A, B, Cd] = ['2026-10-03', '2026-10-04', '2026-10-05'];
  const ctx = setup([{ id: 4801, league: 39, kickoff: `${A}T10:00:00.000Z` }, { id: 4802, league: 39, kickoff: `${A}T12:00:00.000Z` }]);
  await baseline(ctx, [A, B, Cd]);
  assert.equal((await ctx.send(update(4801, 39, `${A}T10:00:00.000Z`, `${B}T10:00:00.000Z`))).status, 200);
  // e.g. major_league_core_publish upserts fixture headers (admin-worker/major-league-snapshot-ingest.mjs) without consulting the checkpoint.
  ctx.db.exec(`UPDATE fixtures SET kickoff_utc='${Cd}T10:00:00.000Z', date_jst='${Cd}' WHERE canonical_id='af:fixture:4801'`);
  const repairs = []; for (let i = 0; i < 3; i += 1) { const r = await ctx.send(REPAIR); repairs.push([r.status, r.body.detail]); }
  const other = await ctx.send(update(4802, 39, `${A}T12:00:00.000Z`, `${B}T12:00:00.000Z`));
  const pub = await publish(ctx, 4801, 39, `${Cd}T10:00:00.000Z`, null, 'n09');
  console.log('N09 evidence', JSON.stringify({ repairs, other: [other.status, other.body.detail], publish: pub, pending: pendingRows(ctx) }));
  assert.equal(repairs.at(-1)[0], 200, 'no automated or Admin-level way out of this state');
});

test('N10 D1 round-trips of one result publication that first has to drain its own schedule repair', async () => {
  const [A, B] = ['2026-10-03', '2026-10-04'];
  const run = async withPending => {
    const ctx = setup([{ id: 4901, league: 39, kickoff: `${A}T10:00:00.000Z` }]);
    await baseline(ctx, [A, B]);
    assert.equal((await ctx.send(update(4901, 39, `${A}T10:00:00.000Z`, `${B}T10:00:00.000Z`))).status, 200);
    if (!withPending) assert.equal((await drain(ctx)).status, 200);
    const root = tmpRoot('n10'); finalBundle(ctx, root, 4901, 39, `${B}T10:00:00.000Z`);
    const plan = createAutomationAdminPlan({ schemaVersion: 'jfw-api-football-automation-plan/1',
      detailFetches: [{ providerFixtureId: 4901, fixtureId: F(4901), competitionId: 'af:competition:39', seasonId: 'af:season:39:2026' }], standingsFetches: [] },
    root, path.join(root, 'd1'));
    const perRequest = [];
    const report = await executeAutomationAdminPlan(plan, { url: 'https://offline.test', token: 't', planDirectory: path.join(root, 'd1'),
      fetchImpl: async (u, i) => { const op = JSON.parse(i.body).operation; const counter = countD1(ctx);
        const res = await adminFetch(ctx)(u, i); counter.restore();
        perRequest.push({ op, status: res.status, single: counter.single, batchStatements: counter.batchStatements, total: counter.single + counter.batchStatements });
        return res; } });
    return { passed: report.passed, perRequest };
  };
  const plain = await run(false); const drained = await run(true);
  console.log('N10 evidence', JSON.stringify({ plain, drained, declaredLimit: 'MAX_D1_QUERIES_PER_INVOCATION = 50; FIXTURE_PREFLIGHT_QUERY_BUDGET = 13 (admin-worker/fixture-ingest.mjs L23-24)' }));
  assert.equal(plain.passed, true); assert.equal(drained.passed, true);
  assert.ok([...plain.perRequest,...drained.perRequest].every(row=>row.total<=50), 'repair and publication requests must each fit the D1 limit');
  const publishDrained = drained.perRequest.find(r => r.op === 'fixture_publish');
  // Independent expectation: the invocation stays inside the limit the module itself declares.
  assert.ok(publishDrained.total <= 50, `publication with drain issues ${publishDrained.total} D1 statements in one invocation`);
});

test('24 competition scopes and an empty old date repair in separate requests below 50 queries', async t => {
  const A='2026-11-10',B='2026-11-11';
  const ctx=setup([9701,9702,9703].map((id,index)=>({id,league:[39,140,48][index],kickoff:`${A}T10:00:00.000Z`})));
  t.after(()=>ctx.db.close());
  for(let i=4;i<=24;i+=1) {
    const league=2000+i,id=9700+i;
    ctx.db.exec(`INSERT INTO competitions(id,canonical_id,source_id,provider_id,name,country_name,type)
      VALUES(${i},'af:competition:${league}',1,${league},'League ${league}','England','League');
      INSERT INTO competition_seasons(id,canonical_id,competition_id,product_season_id,provider_season,label,status)
      VALUES(${i},'af:season:${league}:2026',${i},1,2026,'2026','active');
      INSERT INTO fixtures(canonical_id,source_id,provider_id,competition_season_id,home_team_id,away_team_id,
        kickoff_utc,date_jst,status_short,status_long,ingestion_state)
      VALUES('af:fixture:${id}',1,${id},${i},1,2,'${A}T10:00:00.000Z','${A}','NS','Not Started','scheduled');`);
  }
  await baseline(ctx,[A,B]);
  assert.equal((await ctx.send(update(9701,39,`${A}T10:00:00.000Z`,`${B}T10:00:00.000Z`))).status,200);
  ctx.db.exec(`UPDATE fixtures SET kickoff_utc='${B}T10:00:00.000Z',date_jst='${B}' WHERE canonical_id!='af:fixture:9701'`);
  const totals=[];
  for(let i=0;i<100;i+=1) {
    const counter=countD1(ctx);const result=await ctx.send(REPAIR);counter.restore();
    const queries=counter.single+counter.batchStatements;totals.push(queries);
    assert.equal(result.status,200,JSON.stringify(result));
    assert.ok(queries<=50,`repair requested ${queries} D1 queries`);
    if(result.body.report.repaired===null) break;
  }
  assert.equal(totals.length,3,'two date repairs and an empty-queue read');
  assert.deepEqual(r2Ids(ctx,G(A)),[]);
  assert.equal(r2Ids(ctx,G(B)).length,24);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM date_index_repair_queue').get().n,0);
  assert.equal(pendingRows(ctx).length,0);
  console.log('24-competition D1 request budgets',JSON.stringify(totals));
});
