// Adapted regression tests; these results are not an independent review.
// Re-review (PR #123 b77d9cb): 15-minute result automation — isolation, state advance, relocation recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, drain, setup, baseline, update, r2Ids, pendingRows, fixtureRow, coverage, feedOrError,
  dateIndexR2Key, competitionDateIndexR2Key, finalBundle, tmpRoot, adminFetch, createAutomationAdminPlan,
} from './helpers/schedule-r2-harness.mjs';

const require = createRequire(import.meta.url);
const { planAutomation, checkpointAutomationDiscovery, emptyAutomationState } = require(path.join(ROOT, 'scripts/v2/api-football-automation-plan.js'));
const { executeAutomationFetches } = require(path.join(ROOT, 'scripts/v2/execute-api-football-automation-fetches.js'));
const policy = { ...require(path.join(ROOT, 'config/api-football-automation.json')), scheduledSynchronizationEnabled: true };
const { executeAutomationAdminPlan } = await import(path.join(ROOT, 'scripts/d1/execute-automation-admin-plan.mjs'));
const G = dateIndexR2Key; const C = (l, d) => competitionDateIndexR2Key(`af:competition:${l}`, d); const F = id => `af:fixture:${id}`;
const NOW = new Date('2026-10-04T00:00:00.000Z');
const storedDates = ctx => ctx.db.prepare('SELECT canonical_id AS fixture_id, date_jst FROM fixtures ORDER BY canonical_id').all().map(r => ({ ...r }));
const budget = { dateUtc: '2026-10-04', fixtureIds: [] };

function plan(ctx, state, fixturesByDate) {
  return planAutomation({ policy, state, fixturesByDate, now: NOW, quota: { dailyRemaining: 7000 }, dailyBudget: budget, storedDates: storedDates(ctx) });
}
// Workflow steps "Bind", "Publish through Admin", "Advance durable state" (the last one through the real CLI).
async function publishAndAdvance(ctx, root, p, state, ready, tag) {
  const admin = createAutomationAdminPlan({ schemaVersion: p.schemaVersion, detailFetches: p.detailFetches, standingsFetches: [] }, root, path.join(root, `d1-${tag}`));
  const rejects = [];
  const report = await executeAutomationAdminPlan(admin, { url: 'https://offline.test', token: 't', planDirectory: path.join(root, `d1-${tag}`),
    readyFixtures: ready, fetchImpl: async (u, i) => { const r = await adminFetch(ctx)(u, i);
      if (!r.ok) rejects.push([JSON.parse(i.body).operation, (await r.clone().json()).detail]); return r; } });
  const files = Object.fromEntries(['plan', 'report', 'state', 'next'].map(n => [n, path.join(root, `${n}-${tag}.json`)]));
  fs.writeFileSync(files.plan, JSON.stringify(p)); fs.writeFileSync(files.report, JSON.stringify(report)); fs.writeFileSync(files.state, JSON.stringify(state));
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts/v2/advance-api-football-automation-state.js'), '--plan', files.plan,
    '--report', files.report, '--state', files.state, '--out', files.next], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(cli.status, 0, cli.stderr);
  return { report, rejects, next: JSON.parse(fs.readFileSync(files.next, 'utf8')) };
}
const stages = (state, id) => state.fixtures[F(id)]?.completedStages ?? null;

test('B01 result crossed a JST date after the last schedule scan: relocation is declared and both dates converge', async () => {
  const ctx = setup([{ id: 5001, league: 39, kickoff: '2026-10-03T14:00:00.000Z' }, { id: 5002, league: 39, kickoff: '2026-10-03T12:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-03', '2026-10-04']);
  const root = tmpRoot('b01');
  const raw = finalBundle(ctx, root, 5001, 39, '2026-10-03T15:30:00.000Z');       // JST 10-04 00:30
  const by = { '2026-10-03': [], '2026-10-04': [raw], '2026-10-05': [] };
  const state = checkpointAutomationDiscovery(emptyAutomationState(), plan(ctx, emptyAutomationState(), by));
  const p = plan(ctx, state, by);
  assert.deepEqual(p.detailFetches.map(d => [d.fixtureId, d.previousDateJst]), [[F(5001), '2026-10-03']]);
  const out = await publishAndAdvance(ctx, root, p, state, [F(5001)], 'r1');
  assert.equal(out.report.passed, true, JSON.stringify(out.rejects));
  assert.deepEqual([r2Ids(ctx, G('2026-10-03')), r2Ids(ctx, G('2026-10-04')), r2Ids(ctx, C(39, '2026-10-03')), r2Ids(ctx, C(39, '2026-10-04'))],
    [[F(5002)], [F(5001)], [F(5002)], [F(5001)]]);
  assert.deepEqual(stages(out.next, 5001), ['initial']);
});

test('B02 one fixture quarantined by the shell step and one refused by Admin: the healthy fixture completes; only it advances; the others are retried', async () => {
  const ctx = setup([5101, 5102, 5103].map((id, i) => ({ id, league: 39, kickoff: `2026-10-03T1${i}:00:00.000Z` })));
  await baseline(ctx, ['2026-10-03']);
  const root = tmpRoot('b02');
  const raws = [5101, 5102, 5103].map((id, i) => finalBundle(ctx, root, id, 39, `2026-10-03T1${i}:00:00.000Z`, { putR2: id !== 5103 }));
  const by = { '2026-10-03': raws, '2026-10-04': [], '2026-10-05': [] };
  const state = checkpointAutomationDiscovery(emptyAutomationState(), plan(ctx, emptyAutomationState(), by));
  const p = plan(ctx, state, by);
  assert.equal(p.detailFetches.length, 3);
  // 5101 healthy; 5102 not in ready-fixtures.txt (shell quarantine); 5103 "ready" but its R2 object is absent (Admin 404).
  const out = await publishAndAdvance(ctx, root, p, state, [F(5101), F(5103)], 'r1');
  const next = plan(ctx, out.next, by).detailFetches.map(d => d.fixtureId);
  console.log('B02 evidence', JSON.stringify({ passed: out.report.passed, successful: out.report.successfulFixtures, rejects: out.rejects,
    outcomes: out.report.outcomes.map(o => [o.identity, o.passed, o.reason || null]),
    stages: [5101, 5102, 5103].map(id => stages(out.next, id)), published: [5101, 5102, 5103].map(id => fixtureRow(ctx, id).published_revision !== null), nextRunCandidates: next }));
  assert.equal(out.report.passed, false);
  assert.deepEqual(out.report.successfulFixtures, [F(5101)]);
  assert.deepEqual([5101, 5102, 5103].map(id => stages(out.next, id)), [['initial'], [], []]);
  assert.deepEqual([5101, 5102, 5103].map(id => fixtureRow(ctx, id).published_revision !== null), [true, false, false]);
  assert.ok([F(5102), F(5103)].every(id => next.includes(id)), 'failed fixtures must be planned again');
});

test('B03 [RELOCATION INTERRUPTED] D1 relocated, one date-index write fails once: do later runs repair the old date?', async () => {
  const [A, B] = ['2026-10-03', '2026-10-04'];
  const verdicts = [];
  for (const failing of [G(A), C(39, A), G(B)]) {
    const ctx = setup([{ id: 5201, league: 39, kickoff: `${A}T14:00:00.000Z` }, { id: 5202, league: 39, kickoff: `${A}T12:00:00.000Z` }]);
    await baseline(ctx, [A, B]);
    const root = tmpRoot('b03');
    const raw = finalBundle(ctx, root, 5201, 39, `${A}T15:30:00.000Z`);
    const by = { [A]: [], [B]: [raw], '2026-10-05': [] };
    let state = checkpointAutomationDiscovery(emptyAutomationState(), plan(ctx, emptyAutomationState(), by));
    const runs = [];
    ctx.faults.failPutKeys.add(failing);
    for (let run = 1; run <= 3; run += 1) {
      const p = plan(ctx, state, by);
      if (!p.detailFetches.length) { runs.push({ planned: [], note: 'nothing due' }); continue; }
      const out = await publishAndAdvance(ctx, root, p, state, p.detailFetches.map(d => d.fixtureId), `r${run}`);
      runs.push({ planned: p.detailFetches.map(d => [d.fixtureId, d.previousDateJst ?? null]), passed: out.report.passed, rejects: out.rejects });
      state = out.next;
    }
    const end = { d1Date: fixtureRow(ctx, 5201).date_jst, r2A: r2Ids(ctx, G(A)), r2cA: r2Ids(ctx, C(39, A)), r2B: r2Ids(ctx, G(B)), covA: coverage(ctx, A).generic,
      feedA: (await feedOrError(ctx, A)).ids, pending: pendingRows(ctx).length, stages: stages(state, 5201) };
    // Follow-up: the other fixture on the old date finishes and is published by a later run.
    const raw2 = finalBundle(ctx, root, 5202, 39, `${A}T12:00:00.000Z`);
    const by2 = { [A]: [raw2], [B]: [raw], '2026-10-05': [] };
    const st2 = checkpointAutomationDiscovery(state, plan(ctx, state, by2));
    const p2 = plan(ctx, st2, by2);
    const only = { ...p2, detailFetches: p2.detailFetches.filter(d => d.fixtureId === F(5202)) };
    const follow = await publishAndAdvance(ctx, root, only, st2, [F(5202)], 'follow');
    const ok = JSON.stringify([end.r2A, end.r2cA, end.r2B]) === JSON.stringify([[F(5202)], [F(5202)], [F(5201)]]) && end.covA === 1;
    verdicts.push(ok);
    console.log('B03 evidence', JSON.stringify({ failing, runs, end, followUp5202: { passed: follow.report.passed, rejects: follow.rejects, stages: stages(follow.next, 5202) } }));
  }
  // Independent expectation after retries: 5201 only on B in every store; A lists only 5202 and has D1 coverage.
  assert.deepEqual(verdicts, [true, true, true]);
});

test('B04 a failed detail fetch quarantines only its fixture', async () => {
  const items = [5301, 5302, 5303].map(id => ({ providerFixtureId: id, fixtureId: F(id), competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
    league: 39, season: 2026, kickoffUtc: '2026-10-03T10:00:00.000Z', status: 'FT', recheckStage: 'initial', dueAt: '2026-10-03T13:00:00.000Z' }));
  const requested = [];
  const row = id => ({ fixture: { id, date: '2026-10-03T10:00:00+00:00', status: { short: 'FT', long: 'Match Finished', elapsed: 90 } },
    league: { id: 39, season: 2026, name: 'L', country: 'C' }, teams: { home: { id: 40, name: 'H' }, away: { id: 50, name: 'A' } }, goals: { home: 1, away: 0 }, score: {} });
  const client = { async get(name, params) { requested.push(`${name}:${params.id ?? params.fixture ?? ''}`);
    const id = Number(params.id ?? params.fixture);
    if (id === 5301) throw new Error('HTTP 500 for fixture 5301');
    return { data: { response: name === 'fixtures' ? [row(id)] : [] , paging: { total: 1 } }, quota: { dailyRemaining: 7000 } }; } };
  const out = tmpRoot('b04'); let error = null;
  try { await executeAutomationFetches({ plan: { schemaVersion: 'jfw-api-football-automation-plan/1', mode: 'enabled', detailFetches: items, standingsFetches: [] }, outputRoot: out, client }); }
  catch (e) { error = e.message; }
  const fetched = [5301, 5302, 5303].filter(id => fs.existsSync(path.join(out, 'fixtures', String(id), 'fixture.json')));
  console.log('B04 evidence', JSON.stringify({ error, fetchedArtifacts: fetched, requestedFixtureIds: [...new Set(requested.map(r => r.split(':')[1]))] }));
  // Independent expectation (README item 4): the other two fixtures are fetched and can be published.
  assert.deepEqual(fetched, [5302, 5303]);
});

test('B05 a detail date returning to its stored value preserves the other Admin plan entries', async () => {
  const ctx = setup([{ id: 5401, league: 39, kickoff: '2026-10-03T14:00:00.000Z' }, { id: 5402, league: 39, kickoff: '2026-10-03T12:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-03', '2026-10-04']);
  const root = tmpRoot('b05');
  // Discovery saw 5401 at 15:30Z (JST 10-04) -> previousDateJst 10-03; the detail fetch minutes later returns 14:00Z again (JST 10-03).
  const discovered = finalBundle(ctx, root, 5401, 39, '2026-10-03T15:30:00.000Z');
  const ok = finalBundle(ctx, root, 5402, 39, '2026-10-03T12:00:00.000Z');
  const by = { '2026-10-03': [ok], '2026-10-04': [discovered], '2026-10-05': [] };
  const state = checkpointAutomationDiscovery(emptyAutomationState(), plan(ctx, emptyAutomationState(), by));
  const p = plan(ctx, state, by);
  finalBundle(ctx, root, 5401, 39, '2026-10-03T14:00:00.000Z');                       // artifact now back on 10-03
  let error = null;let bound;
  try { bound=createAutomationAdminPlan({ schemaVersion: p.schemaVersion, detailFetches: p.detailFetches, standingsFetches: [] }, root, path.join(root, 'd1')); }
  catch (e) { error = e.message; }
  console.log('B05 evidence', JSON.stringify({ planned: p.detailFetches.map(d => [d.fixtureId, d.previousDateJst ?? null]), error }));
  assert.equal(error,null);
  assert.deepEqual(bound.fixtures.map(f=>f.fixtureId),[F(5401),F(5402)]);
  assert.equal(bound.fixtures[0].requireStableDate,true);
  assert.equal(bound.fixtures[0].expectedPreviousDate,undefined);
});

test('B06 kickoff correction of a retained final fixture no longer throws and is carried into state', () => {
  const ctx = setup([{ id: 5501, league: 39, kickoff: '2026-10-03T14:00:00.000Z' }]);
  const raw = { fixture: { id: 5501, date: '2026-10-03T14:00:00Z', status: { short: 'FT' } }, league: { id: 39, season: 2026 } };
  const by = { '2026-10-03': [raw], '2026-10-04': [], '2026-10-05': [] };
  const state = checkpointAutomationDiscovery(emptyAutomationState(), plan(ctx, emptyAutomationState(), by));
  const corrected = structuredClone(raw); corrected.fixture.date = '2026-10-03T14:15:00Z';
  const p = plan(ctx, state, { ...by, '2026-10-03': [corrected] });
  const next = checkpointAutomationDiscovery(state, p);
  assert.equal(next.fixtures[F(5501)].kickoffUtc, '2026-10-03T14:15:00.000Z');
  assert.deepEqual(p.detailFetches.map(d => d.fixtureId), [F(5501)]);
});

test('B07 discovery uses the strict stored-dates parser', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/v2/discover-api-football-automation.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes("'D1 stored dates'"));
  console.log('B07 evidence', JSON.stringify({ line: line.trim() }));
  // `readJson(...)?.[0]?.results : null` -> a wrangler error object or `[{success:false}]` yields undefined -> `|| null` -> no storedDates.
  const ctx = setup([{ id: 5601, league: 39, kickoff: '2026-10-03T14:00:00.000Z' }]);
  const raw = { fixture: { id: 5601, date: '2026-10-03T15:30:00Z', status: { short: 'FT' } }, league: { id: 39, season: 2026 } };
  const by = { '2026-10-03': [], '2026-10-04': [raw], '2026-10-05': [] };
  const state = checkpointAutomationDiscovery(emptyAutomationState(), planAutomation({ policy, state: emptyAutomationState(), fixturesByDate: by, now: NOW,
    quota: { dailyRemaining: 7000 }, dailyBudget: budget, storedDates: ([{ success: false }])?.[0]?.results || null }));
  const p = planAutomation({ policy, state, fixturesByDate: by, now: NOW, quota: { dailyRemaining: 7000 }, dailyBudget: budget, storedDates: ([{ success: false }])?.[0]?.results || null });
  assert.equal(p.detailFetches[0].previousDateJst, undefined); // fail-open: falls back to requireStableDate -> per-fixture rejection each run
});
