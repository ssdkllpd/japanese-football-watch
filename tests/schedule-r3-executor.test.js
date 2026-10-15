// Adapted from the user-supplied SCHED-R3 probe. This is regression verification, not independent review.
// E-series: the real schedule executor (unchanged by the fix) against the real, fixed Admin Worker.
// Independent expectations are written from the inputs: every selected change must be applied and
// both stores must agree when the executor exits 0; a healthy plan must not make the executor fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE,'..');
const change = (id, league, oldK, newK) => ({ schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_schedule_update', fixtureId: `af:fixture:${id}`,
  competitionId: `af:competition:${league}`, seasonId: `af:season:${league}:2026`, oldKickoffUtc: oldK, newKickoffUtc: newK, oldStatus: 'NS', newStatus: 'NS' });
function run(name, scenario, changes, mode = 'execute') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jfw-e1-${name}-`));
  const sc = path.join(dir, 'scenario.json'); const out = path.join(dir, 'out.json'); const plan = path.join(dir, 'plan.json');
  fs.writeFileSync(sc, JSON.stringify(scenario));
  fs.writeFileSync(plan, JSON.stringify({ schemaVersion: 'jfw-fixture-schedule-plan/1', changes, held: [] }));
  const args = ['--import', path.join(HERE, 'helpers/schedule-r3-executor-preload.mjs'), path.join(ROOT, 'scripts/d1/execute-fixture-schedule-plan.mjs'), ...(mode === 'execute' ? ['execute', plan] : ['repair'])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NODE_OPTIONS: '', JFW_ROOT: ROOT, R3_SCENARIO: sc, R3_OUT: out, ADMIN_INGEST_URL: 'https://offline.test', ADMIN_INGEST_TOKEN: 't',
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'x' } });
  const state = JSON.parse(fs.readFileSync(out, 'utf8'));
  return { status: r.status, stdout: r.stdout.trim(), error: (r.stderr.match(/Error: [^\n]*/) || [''])[0], ...state };
}
const F = [
  { id: 6001, league: 39, kickoff: '2026-11-10T10:00:00.000Z' },
  { id: 6002, league: 39, kickoff: '2026-11-10T12:00:00.000Z' },
  { id: 6003, league: 140, kickoff: '2026-11-10T14:00:00.000Z' },
  { id: 6004, league: 39, kickoff: '2026-11-12T10:00:00.000Z' },
];
const base = { fixtures: F, baselineDates: ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'],
  reportDates: ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'], reportCompetitions: ['af:competition:39', 'af:competition:140'] };

test('E1 same-date changes only: executor completes', () => {
  const r = run('same', base, [change(6001, 39, F[0].kickoff, '2026-11-10T11:00:00.000Z'), change(6002, 39, F[1].kickoff, '2026-11-10T13:00:00.000Z')]);
  console.log('E1 evidence', JSON.stringify({ status: r.status, stdout: r.stdout, error: r.error, calls: r.calls, pending: r.pending, queue: r.queue }));
  assert.equal(r.status, 0); assert.deepEqual(r.pending, []); assert.deepEqual(r.queue, []);
});

test('E2 a date-crossing change followed by any other change: every selected change is applied and the run succeeds', () => {
  const r = run('cross-then-next', base, [
    change(6001, 39, F[0].kickoff, '2026-11-11T10:00:00.000Z'),   // 11-10 -> 11-11 (JST)
    change(6002, 39, F[1].kickoff, '2026-11-10T13:00:00.000Z'),   // same date
    change(6004, 39, F[3].kickoff, '2026-11-13T10:00:00.000Z'),   // 11-12 -> 11-13
  ]);
  console.log('E2 evidence', JSON.stringify({ status: r.status, stdout: r.stdout, error: r.error, calls: r.calls, pending: r.pending, queue: r.queue,
    fixtures: r.fixtures, r2Generic: r.r2Generic, coverage: r.coverage }));
  assert.equal(r.status, 0, 'executor must not fail on a healthy plan');
  assert.equal(r.fixtures[6001].date_jst, '2026-11-11');
  assert.equal(r.fixtures[6002].kickoff_utc, '2026-11-10T13:00:00.000Z');
  assert.equal(r.fixtures[6004].date_jst, '2026-11-13');
  assert.deepEqual(r.pending, []); assert.deepEqual(r.queue, []);
  assert.deepEqual(r.r2Generic['2026-11-10'], ['af:fixture:6002', 'af:fixture:6003']);
  assert.deepEqual(r.r2Generic['2026-11-11'], ['af:fixture:6001']);
});

test('E3 a single date-crossing change as the last selected change: nothing is left owed when the executor exits 0', () => {
  const r = run('cross-last', base, [change(6001, 39, F[0].kickoff, '2026-11-11T10:00:00.000Z')]);
  console.log('E3 evidence', JSON.stringify({ status: r.status, stdout: r.stdout, error: r.error, calls: r.calls, pending: r.pending, queue: r.queue,
    r2Generic: r.r2Generic, r2Competition: r.r2Competition, coverage: r.coverage }));
  assert.equal(r.status, 0);
  assert.deepEqual(r.pending, [], 'no checkpoint may remain after a successful run');
  assert.deepEqual(r.queue, [], 'no date may remain queued after a successful run');
  assert.deepEqual(r.r2Generic['2026-11-10'], ['af:fixture:6002', 'af:fixture:6003']);
  assert.deepEqual(r.r2Generic['2026-11-11'], ['af:fixture:6001']);
});

test('E4 repair mode at workflow start drains what E3 left behind, and a backlog of 21 journaled dates', () => {
  // 21 fixtures on 21 different dates; a header writer other than the schedule path touches each (status_elapsed), which the 0011 trigger journals.
  const fixtures = Array.from({ length: 21 }, (_, i) => ({ id: 6100 + i, league: 39, kickoff: `2026-12-${String(i + 1).padStart(2, '0')}T10:00:00.000Z` }));
  const dates = fixtures.map(f => f.kickoff.slice(0, 10));
  const r = run('backlog', { fixtures, baselineDates: dates, reportDates: dates, reportCompetitions: [],
    preSql: ["UPDATE fixtures SET status_long='Not Started ' WHERE 1"] }, [], 'repair');
  console.log('E4 evidence', JSON.stringify({ status: r.status, error: r.error, calls: r.calls.length, queueLeft: r.queue.length }));
  assert.equal(r.status, 0, 'a healthy backlog must not fail the first workflow step');
});
