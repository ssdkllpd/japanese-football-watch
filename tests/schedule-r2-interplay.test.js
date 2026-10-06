// Adapted regression tests; these results are not an independent review.
// Re-review (PR #123 b77d9cb): additional fault injection — public cache vs audit, D1 change-count semantics,
// publish/update TOCTOU, corrected status vs audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ROOT, drain, setup, baseline, update, r2Ids, pendingRows, fixtureRow, coverage, feedOrError,
  dateIndexR2Key, competitionDateIndexR2Key, finalBundle, tmpRoot, adminFetch, createAutomationAdminPlan,
} from './helpers/schedule-r2-harness.mjs';

const { auditScheduleSync, affectedScheduleScopes } = await import(path.join(ROOT, 'scripts/d1/audit-fixture-schedule-sync.mjs'));
const { SCHEDULE_INVENTORY_SQL } = await import(path.join(ROOT, 'scripts/d1/capture-schedule-audit.mjs'));
const { executeAutomationAdminPlan } = await import(path.join(ROOT, 'scripts/d1/execute-automation-admin-plan.mjs'));
const publicWorker = (await import(path.join(ROOT, 'worker/index.mjs'))).default;
const G = dateIndexR2Key; const C = (l, d) => competitionDateIndexR2Key(`af:competition:${l}`, d); const F = id => `af:fixture:${id}`;
const REPAIR = { operation: 'fixture_schedule_repair' };
const rows = (ctx, sql) => ctx.db.prepare(sql).all().map(r => ({ ...r }));
const COV_G = 'SELECT date_jst,fixture_count,fixture_id_digest FROM date_index_coverages ORDER BY date_jst';
const COV_C = 'SELECT c.canonical_id AS competition_id,coverage.date_jst,coverage.fixture_count,coverage.fixture_id_digest FROM competition_date_index_coverages coverage JOIN competitions c ON c.id=coverage.competition_id ORDER BY c.canonical_id,coverage.date_jst';

function workerEnv(ctx, cache) {
  return { FOOTBALL_DB: ctx.env.FOOTBALL_DB, FOOTBALL_DATA: ctx.env.FOOTBALL_DATA, APP_ORIGINS: 'https://app.test',
    D1_DATE_INDEX_ENABLED: 'true', D1_COMPETITION_DATE_INDEX_ENABLED: 'true', ...(cache ? { RESPONSE_CACHE: cache } : {}) };
}
function memoryCache() { // stands in for the Workers Cache API (caches.default)
  const store = new Map();
  return { store, async match(req) { const hit = store.get(req.url); return hit ? hit.clone() : undefined; }, async put(req, res) { store.set(req.url, res.clone()); } };
}
async function publicGet(ctx, env, scope, fresh = false) {
  const route = scope.competitionId ? `/api/v2/competitions/${encodeURIComponent(scope.competitionId)}/dates/${scope.date}` : `/api/v2/dates/${scope.date}`;
  const res = await publicWorker.fetch(new Request(`https://worker.test${route}${fresh ? "?fresh=1" : ""}`, { headers: { Origin: 'https://app.test' } }), env, { waitUntil() {} });
  return { status: res.status, source: res.headers.get('x-jfw-data-source'), cache: res.headers.get('x-jfw-cache'), cacheControl: res.headers.get('cache-control'), payload: await res.json() };
}
async function auditNow(ctx, env, changes, before) {
  const after = rows(ctx, SCHEDULE_INVENTORY_SQL);
  const scopes = affectedScheduleScopes(changes, before, after);
  const r2 = {};
  for (const [key, scope] of scopes) { const raw = ctx.objects.get(scope.competitionId ? competitionDateIndexR2Key(scope.competitionId, scope.date) : dateIndexR2Key(scope.date)); if (raw !== undefined) r2[key] = JSON.parse(raw); }
  const keys = [...scopes.keys()];
  const sampleKeys = [...new Set([keys.find(k => k.startsWith('all/')), keys.find(k => !k.startsWith('all/')), keys.at(-1)].filter(Boolean))]; // same selection as capture-schedule-audit.mjs L52-54
  const publicSamples = [];
  for (const k of sampleKeys) { const s = await publicGet(ctx, env, scopes.get(k), true); publicSamples.push({ scope: k, status: s.status, payload: s.payload, source: s.source, cache: s.cache }); }
  let verdict;
  try { auditScheduleSync({ corrections: rows(ctx, "SELECT target_canonical_id,field_path,status,applied_value_json FROM correction_states WHERE target_kind='fixture' AND (field_path LIKE 'fixture.status%' OR field_path LIKE 'fixture.teams%' OR field_path LIKE 'fixture.score%') ORDER BY target_canonical_id,field_path"), dateRepairs: rows(ctx, 'SELECT date_jst FROM date_index_repair_queue'), changes, before, after, pending: rows(ctx, 'SELECT fixture_id FROM fixture_schedule_refresh_pending'), genericCoverages: rows(ctx, COV_G),
    competitionCoverages: rows(ctx, COV_C), r2, publicSamples: publicSamples.map(({ scope, status, payload }) => ({ scope, status, payload })), inventoryEnd: rows(ctx, SCHEDULE_INVENTORY_SQL) }); verdict = 'PASS'; }
  catch (e) { verdict = `FAIL: ${e.message}`; }
  return { verdict, samples: publicSamples.map(s => [s.scope, s.status, s.source, s.cache]) };
}

test('K1 fresh audit reads bypass warmed date caches while normal visitors retain the cache', async () => {
  const [A, B] = ['2026-11-10', '2026-11-11'];
  const ctx = setup([{ id: 8001, league: 39, kickoff: `${A}T10:00:00.000Z` }, { id: 8002, league: 39, kickoff: `${A}T12:00:00.000Z` }]);
  await baseline(ctx, [A, B]);
  const cache = memoryCache(); const env = workerEnv(ctx, cache);
  await publicGet(ctx,env,{date:A,competitionId:'af:competition:39'});
  const visitor = await publicGet(ctx, env, { date: A, competitionId: null });          // an ordinary user request before the scan
  const before = rows(ctx, SCHEDULE_INVENTORY_SQL);
  const change = { schemaVersion: 'jfw-d1-admin-ingest/1', ...update(8001, 39, `${A}T10:00:00.000Z`, `${B}T10:00:00.000Z`) };
  assert.equal((await ctx.send(update(8001, 39, `${A}T10:00:00.000Z`, `${B}T10:00:00.000Z`))).status, 200);
  assert.equal((await drain(ctx)).status, 200);
  const cold = await auditNow(ctx, workerEnv(ctx, null), [change], before);               // same state, no cached response
  const warm = await auditNow(ctx, env, [change], before);                                // what the workflow does seconds after the write
  console.log('K1 evidence', JSON.stringify({ visitor: [visitor.status, visitor.source, visitor.cache, visitor.cacheControl], cold, warm,
    stored: { r2A: r2Ids(ctx, G(A)), r2B: r2Ids(ctx, G(B)), covA: coverage(ctx, A).generic, covB: coverage(ctx, B).generic, pending: pendingRows(ctx).length } }));
  assert.equal(cold.verdict, 'PASS');
  // Independent expectation: D1, R2 and coverage are correct, so the audit should not report a failure.
  assert.equal(warm.verdict, 'PASS');
  const cachedVisitor=await publicGet(ctx,env,{date:A,competitionId:null});
  assert.equal(cachedVisitor.cache,'hit');
  assert.equal(cachedVisitor.payload.fixtures.length,2,'ordinary cache remains intact; audits opt into a fresh read');
});

test('K2 D1 trigger change counts do not falsely reject a committed header update', async () => {
  const [A, B] = ['2026-11-10', '2026-11-11'];
  const run = async (newKickoff) => {
    const ctx = setup([{ id: 8101, league: 39, kickoff: `${A}T10:00:00.000Z` }]);
    await baseline(ctx, [A, B]);
    const db = ctx.env.FOOTBALL_DB; const realBatch = db.batch.bind(db); let reported = null;
    // Report each statement's change count as the delta of total_changes(), i.e. including rows touched by triggers.
    db.batch = async statements => {
      const results = []; ctx.db.exec('BEGIN');
      try {
        for (const s of statements) { const t0 = ctx.db.prepare('SELECT total_changes() AS n').get().n; const r = await s.run();
          const t1 = ctx.db.prepare('SELECT total_changes() AS n').get().n; results.push({ ...r, meta: { ...r.meta, changes: t1 - t0 } }); }
        ctx.db.exec('COMMIT');
      } catch (e) { ctx.db.exec('ROLLBACK'); throw e; }
      reported = results.map(r => r.meta.changes); db.batch = realBatch; return results;
    };
    const u = await ctx.send(update(8101, 39, `${A}T10:00:00.000Z`, newKickoff));
    const state = { status: u.status, detail: u.body.detail ?? null, reportedChanges: reported, row: fixtureRow(ctx, 8101), pending: pendingRows(ctx).length };
    const r = await ctx.send(REPAIR);
    return { ...state, repair: r.status, pendingAfterRepair: pendingRows(ctx).length };
  };
  const sameDate = await run(`${A}T11:00:00.000Z`);
  const dateChange = await run(`${B}T10:00:00.000Z`);
  console.log('K2 evidence', JSON.stringify({ sameDate, dateChange }));
  assert.equal(sameDate.status, 200);
  // Under this change-count semantics the committed update must still be reported as a success.
  assert.equal(dateChange.status, 200, 'update committed (row moved, checkpoint written) but the Admin API answered 422');
});

test('K3 [TOCTOU] publication passes its pending check, then a schedule update commits, then the publication batch commits', async () => {
  const [A, B, Cd] = ['2026-11-10', '2026-11-11', '2026-11-12'];
  const run = async (bundleDate, previousDateJst) => {
    const ctx = setup([{ id: 8201, league: 39, kickoff: `${A}T10:00:00.000Z` }, { id: 8202, league: 39, kickoff: `${A}T12:00:00.000Z` }]);
    await baseline(ctx, [A, B, Cd]);
    const root = tmpRoot('k3'); finalBundle(ctx, root, 8201, 39, `${bundleDate}T10:00:00.000Z`);
    const plan = createAutomationAdminPlan({ schemaVersion: 'jfw-api-football-automation-plan/1', detailFetches: [{ providerFixtureId: 8201, fixtureId: F(8201),
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026', ...(previousDateJst ? { previousDateJst } : {}) }], standingsFetches: [] }, root, path.join(root, 'd1'));
    const db = ctx.env.FOOTBALL_DB; const realBatch = db.batch.bind(db); let injected = null;
    db.batch = async statements => {            // first batch of the publication = the fixture publish transaction
      db.batch = realBatch;
      injected = (await ctx.send(update(8201, 39, `${A}T10:00:00.000Z`, `${B}T10:00:00.000Z`))).status;   // concurrent schedule scan A -> B
      return realBatch(statements);
    };
    const rejects = [];
    const report = await executeAutomationAdminPlan(plan, { url: 'https://offline.test', token: 't', planDirectory: path.join(root, 'd1'),
      fetchImpl: async (u, i) => { const r = await adminFetch(ctx)(u, i); if (!r.ok) rejects.push([JSON.parse(i.body).operation, (await r.clone().json()).detail]); return r; } });
    db.batch = realBatch;
    const repairs = []; for (let i = 0; i < 2; i += 1) { const r = await ctx.send(REPAIR); repairs.push([r.status, r.body.detail ?? r.body.report?.repaired ?? null]); }
    const pendingBeforeOther = pendingRows(ctx);
    const snapshot = { r2: { A: r2Ids(ctx, G(A)), B: r2Ids(ctx, G(B)), C: r2Ids(ctx, G(Cd)) }, cov: { A: coverage(ctx, A).generic, B: coverage(ctx, B).generic, C: coverage(ctx, Cd).generic } };
    const other = await ctx.send(update(8202, 39, `${A}T12:00:00.000Z`, `${B}T12:00:00.000Z`));
    return { injectedUpdate: injected, publishPassed: report.passed, rejects, row: fixtureRow(ctx, 8201), repairs, otherUpdate: other.status, pending: pendingBeforeOther, ...snapshot, _ignored: {
      } };
  };
  const sameAsScan = await run(B, A);      // result bundle agrees with the scan (kickoff on B); relocation A -> B declared
  const elsewhere = await run(A, null);    // result bundle still says A (provider flip-flop between the two reads)
  console.log('K3 evidence', JSON.stringify({ sameAsScan, elsewhere }));
  // Independent expectation: no permanent checkpoint, other fixtures can still be rescheduled.
  assert.equal(sameAsScan.pending.length, 0); assert.equal(sameAsScan.otherUpdate, 200);
  assert.equal(elsewhere.pending.length, 0, 'checkpoint can never be repaired'); assert.equal(elsewhere.otherUpdate, 200);
});

test('K4 audit accepts the active status correction projected into public and R2 indexes', async () => {
  const [A, B] = ['2026-11-10', '2026-11-11'];
  const ctx = setup([{ id: 8301, league: 39, kickoff: `${A}T10:00:00.000Z` }, { id: 8302, league: 39, kickoff: `${A}T12:00:00.000Z` }]);
  ctx.db.prepare(`INSERT INTO correction_states(correction_key,target_kind,target_canonical_id,field_path,status,provider_baseline_json,applied_value_json)
    VALUES('k4','fixture','af:fixture:8302','fixture.status.long','active','"Not Started"','"Kick-off delayed"')`).run();
  await baseline(ctx, [A, B]);
  const before = rows(ctx, SCHEDULE_INVENTORY_SQL);
  const change = { schemaVersion: 'jfw-d1-admin-ingest/1', ...update(8301, 39, `${A}T10:00:00.000Z`, `${B}T10:00:00.000Z`) };
  assert.equal((await ctx.send(update(8301, 39, `${A}T10:00:00.000Z`, `${B}T10:00:00.000Z`))).status, 200);
  assert.equal((await drain(ctx)).status, 200);
  const out = await auditNow(ctx, workerEnv(ctx, null), [change], before);
  console.log('K4 evidence', JSON.stringify(out));
  assert.equal(out.verdict, 'PASS');
});
