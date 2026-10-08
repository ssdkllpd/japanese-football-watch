// Adapted regression tests; these results are not an independent review.
// Re-review (PR #123 b77d9cb): replacement schedule audit, driven with evidence produced by the
// real Admin update/repair path, the real R2 objects and the real public Worker route handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ROOT, drain, setup, baseline, update, jst, dateIndexR2Key, competitionDateIndexR2Key, finalBundle, tmpRoot, adminFetch, createAutomationAdminPlan,
} from './helpers/schedule-r2-harness.mjs';

const { auditScheduleSync, affectedScheduleScopes } = await import(path.join(ROOT, 'scripts/d1/audit-fixture-schedule-sync.mjs'));
const { SCHEDULE_INVENTORY_SQL } = await import(path.join(ROOT, 'scripts/d1/capture-schedule-audit.mjs'));
const { executeAutomationAdminPlan } = await import(path.join(ROOT, 'scripts/d1/execute-automation-admin-plan.mjs'));
const publicWorker = (await import(path.join(ROOT, 'worker/index.mjs'))).default;
const F = id => `af:fixture:${id}`;
const rows = (ctx, sql) => ctx.db.prepare(sql).all().map(r => ({ ...r }));
const COV_G = 'SELECT date_jst,fixture_count,fixture_id_digest FROM date_index_coverages ORDER BY date_jst';
const COV_C = 'SELECT c.canonical_id AS competition_id,coverage.date_jst,coverage.fixture_count,coverage.fixture_id_digest FROM competition_date_index_coverages coverage JOIN competitions c ON c.id=coverage.competition_id ORDER BY c.canonical_id,coverage.date_jst';

async function publicSample(ctx, scopeKey, scope) {
  const route = scope.competitionId ? `/api/v2/competitions/${encodeURIComponent(scope.competitionId)}/dates/${scope.date}` : `/api/v2/dates/${scope.date}`;
  const env = { ...ctx.env, FOOTBALL_DB: ctx.env.FOOTBALL_DB, FOOTBALL_DATA: ctx.env.FOOTBALL_DATA, APP_ORIGINS: 'https://app.test',
    D1_DATE_INDEX_ENABLED: 'true', D1_COMPETITION_DATE_INDEX_ENABLED: 'true' };
  const res = await publicWorker.fetch(new Request(`https://worker.test${route}`, { headers: { Origin: 'https://app.test' } }), env, { waitUntil() {} });
  return { scope: scopeKey, status: res.status, source: res.headers.get('x-jfw-data-source'), payload: await res.json() };
}

// 60 league fixtures over 6 days, one League Cup fixture and one published final on affected dates; 8 header changes.
async function world() {
  const base = Date.parse('2026-11-10T10:00:00.000Z');
  const fixtures = [];
  for (let i = 0; i < 60; i += 1) fixtures.push({ id: 6000 + i, league: i % 2 ? 140 : 39, kickoff: new Date(base + (i % 6) * 86400000 + (i % 5) * 3600000).toISOString() });
  fixtures.push({ id: 6900, league: 48, kickoff: new Date(base + 86400000 + 1800000).toISOString() });   // outside the ten seasons
  const ctx = setup(fixtures);
  const dates = new Set(fixtures.map(f => jst(f.kickoff)));
  const changes = [];
  for (let i = 0; i < 8; i += 1) {
    const f = fixtures[i]; const moved = i < 6;
    const nk = moved ? new Date(Date.parse(f.kickoff) + 86400000 + 5400000).toISOString() : f.kickoff;
    changes.push({ schemaVersion: 'jfw-d1-admin-ingest/1', ...update(f.id, f.league, f.kickoff, nk, 'NS', moved ? 'NS' : (i === 6 ? 'PST' : 'CANC')) });
    dates.add(jst(nk));
  }
  await baseline(ctx, [...dates].sort());
  // A published final (unselected) on an affected date, through the real publication path.
  const root = tmpRoot('x'); const pub = fixtures[20];
  finalBundle(ctx, root, pub.id, pub.league, pub.kickoff);
  const plan = createAutomationAdminPlan({ schemaVersion: 'jfw-api-football-automation-plan/1', detailFetches: [{ providerFixtureId: pub.id, fixtureId: F(pub.id),
    competitionId: `af:competition:${pub.league}`, seasonId: `af:season:${pub.league}:2026` }], standingsFetches: [] }, root, path.join(root, 'd1'));
  assert.equal((await executeAutomationAdminPlan(plan, { url: 'https://offline.test', token: 't', planDirectory: path.join(root, 'd1'), fetchImpl: adminFetch(ctx) })).passed, true);
  const before = rows(ctx, SCHEDULE_INVENTORY_SQL);
  for (const c of changes) {
    const { schemaVersion, ...payload } = c;
    assert.equal((await ctx.send(payload)).status, 200, JSON.stringify(payload));
    assert.equal((await drain(ctx)).status, 200);
  }
  return { ctx, changes, before, published: pub };
}
async function capture({ ctx, changes, before }) {
  const after = rows(ctx, SCHEDULE_INVENTORY_SQL);
  const scopes = affectedScheduleScopes(changes, before, after);
  const r2 = {};
  for (const [key, scope] of scopes) {
    const raw = ctx.objects.get(scope.competitionId ? competitionDateIndexR2Key(scope.competitionId, scope.date) : dateIndexR2Key(scope.date));
    if (raw !== undefined) r2[key] = JSON.parse(raw);
  }
  const keys = [...scopes.keys()];
  const sampleKeys = [...new Set([keys.find(k => k.startsWith('all/')), keys.find(k => !k.startsWith('all/')), keys.at(-1)].filter(Boolean))];
  const publicSamples = [];
  for (const k of sampleKeys) publicSamples.push(await publicSample(ctx, k, scopes.get(k)));
  return { changes, before, after, pending: rows(ctx, 'SELECT fixture_id FROM fixture_schedule_refresh_pending'), genericCoverages: rows(ctx, COV_G),
    competitionCoverages: rows(ctx, COV_C), r2, publicSamples, inventoryEnd: rows(ctx, SCHEDULE_INVENTORY_SQL), scopes };
}
const verdict = data => { try { const r = auditScheduleSync(data); return `PASS(${r.verifiedChanges}/${r.verifiedPreservedFixtures}/${r.verifiedR2Scopes}/${r.verifiedPublicSamples})`; } catch (e) { return `FAIL: ${e.message}`; } };
const clone = data => ({ ...structuredClone({ ...data, scopes: undefined }), scopes: data.scopes });

test('X audit matrix on real evidence', async () => {
  const w = await world();
  const good = await capture(w);
  const out = {};
  out.X0_consistent_with_cup_and_published = verdict(good);
  out.sources = good.publicSamples.map(s => [s.scope, s.source]);
  out.outsideSeasonScopes = [...good.scopes.keys()].filter(k => k.startsWith('af:competition:48/'));

  const someAll = [...good.scopes.keys()].find(k => k.startsWith('all/'));
  let d = clone(good); d.r2[someAll].fixtures[0].kickoffUtc = '2026-01-01T00:00:00.000Z'; out.X2_r2_kickoff_tampered = verdict(d);
  d = clone(good); d.r2[someAll].fixtures[0].status.short = 'PST'; out.X2_r2_status_tampered = verdict(d);
  d = clone(good); d.r2[someAll].fixtures.pop(); out.X2_r2_fixture_dropped = verdict(d);
  d = clone(good); delete d.r2[[...good.scopes.keys()].at(-1)]; out.X4_r2_evidence_missing = verdict(d);
  d = clone(good); d.publicSamples = []; out.X4_public_samples_missing = verdict(d);
  d = clone(good); d.publicSamples[0].status = 403; out.X4_public_read_refused = verdict(d);
  d = clone(good); d.before = undefined; out.X4_before_inventory_missing = verdict(d);
  d = clone(good); d.pending = [{ fixture_id: F(6000) }]; out.X4_pending_left = verdict(d);

  // held / unselected mutation in D1 (not merely in the evidence): published fixture and a plain one.
  const heldId = F(w.published.id);
  for (const [name, id, sql] of [['X3_published_held_mutated', heldId, "UPDATE fixtures SET status_long='Tampered' WHERE canonical_id=?"],
    ['X3_unselected_status_mutated', F(6050), "UPDATE fixtures SET status_short='CANC' WHERE canonical_id=?"]]) {
    const saved = { ...w.ctx.db.prepare('SELECT status_short, status_long FROM fixtures WHERE canonical_id=?').get(id) };
    w.ctx.db.prepare(sql).run(id);
    out[name] = verdict(await capture(w));
    w.ctx.db.prepare('UPDATE fixtures SET status_short=?, status_long=? WHERE canonical_id=?').run(saved.status_short, saved.status_long, id);
  }
  d = clone(good); d.inventoryEnd.find(r => r.fixture_id === F(6055)).status_short = 'CANC'; out.X5_inventory_changed_during_audit = verdict(d);
  d = clone(good); d.inventoryEnd.pop(); out.X5_inventory_row_vanished = verdict(d);

  // What the audit cannot see.
  d = clone(good); d.r2[someAll].fixtures[0].teams.home.name = 'WRONG TEAM'; d.r2[someAll].fixtures[0].score.goals.home = 9; out.X6_r2_team_and_score_tampered = verdict(d);
  const unsampled = [...good.scopes.keys()].filter(k => !good.publicSamples.some(s => s.scope === k));
  out.X7_public_scopes = { total: good.scopes.size, sampled: good.publicSamples.length, unsampled: unsampled.length };
  // A stale public response (edge cache holds the pre-change body for up to DATE_TTL_SECONDS = 300).
  d = clone(good); const s0 = d.publicSamples[0]; s0.payload.fixtures = s0.payload.fixtures.slice(1); out.X8_public_sample_stale_cached = verdict(d);
  console.log('X evidence', JSON.stringify(out, null, 1));

  assert.match(out.X0_consistent_with_cup_and_published, /^PASS/);
  assert.ok(out.outsideSeasonScopes.length >= 1);
  for (const k of ['X2_r2_kickoff_tampered', 'X2_r2_status_tampered', 'X2_r2_fixture_dropped', 'X4_r2_evidence_missing', 'X4_public_samples_missing',
    'X4_public_read_refused', 'X4_before_inventory_missing', 'X4_pending_left', 'X3_published_held_mutated', 'X3_unselected_status_mutated',
    'X5_inventory_changed_during_audit', 'X5_inventory_row_vanished', 'X8_public_sample_stale_cached']) assert.match(out[k], /^FAIL/, k);
  assert.match(out.X6_r2_team_and_score_tampered, /^FAIL/, 'R2 team/score content is outside the comparison');
});
