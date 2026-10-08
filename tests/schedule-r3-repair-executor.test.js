// Adapted from the user-supplied SCHED-R3 probe. This is regression verification, not independent review.
// E-series, part 2: the real executor in `repair` mode (first step of BOTH workflows) against the fixed Admin Worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const ROOT = path.resolve(HERE,'..');
function run(name, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jfw-e2-${name}-`)); const sc = path.join(dir, 'scenario.json'); const out = path.join(dir, 'out.json');
  fs.writeFileSync(sc, JSON.stringify(scenario));
  const r = spawnSync(process.execPath, ['--import', path.join(HERE, 'helpers/schedule-r3-executor-preload.mjs'), path.join(ROOT, 'scripts/d1/execute-fixture-schedule-plan.mjs'), 'repair'], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NODE_OPTIONS: '', JFW_ROOT: ROOT, R3_SCENARIO: sc, R3_OUT: out, ADMIN_INGEST_URL: 'https://offline.test', ADMIN_INGEST_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'x' } });
  return { status: r.status, error: (r.stderr.match(/Error: [^\n]*/) || [''])[0], ...JSON.parse(fs.readFileSync(out, 'utf8')) };
}
const upd = (id, o, n) => ({ operation: 'fixture_schedule_update', fixtureId: `af:fixture:${id}`, competitionId: 'af:competition:39', seasonId: 'af:season:39:2026', oldKickoffUtc: o, newKickoffUtc: n, oldStatus: 'NS', newStatus: 'NS' });
const days = n => Array.from({ length: n }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);

test('E5 the next run drains what a date-crossing change left behind (state after E3: one repair call made)', () => {
  const fixtures = [{ id: 6001, league: 39, kickoff: '2026-11-10T10:00:00.000Z' }, { id: 6002, league: 39, kickoff: '2026-11-10T12:00:00.000Z' }];
  const r = run('leftover', { fixtures, baselineDates: ['2026-11-10', '2026-11-11'], reportDates: ['2026-11-10', '2026-11-11'], reportCompetitions: ['af:competition:39'],
    preAdmin: [upd(6001, fixtures[0].kickoff, '2026-11-11T10:00:00.000Z'), { operation: 'fixture_schedule_repair' }] });
  console.log('E5 evidence', JSON.stringify({ status: r.status, calls: r.calls.map(c => c.result), pending: r.pending, queue: r.queue, r2Generic: r.r2Generic, coverage: r.coverage }));
  assert.equal(r.status, 0); assert.deepEqual(r.pending, []); assert.deepEqual(r.queue, []);
  assert.deepEqual(r.r2Generic, { '2026-11-10': ['af:fixture:6002'], '2026-11-11': ['af:fixture:6001'] });
});
for (const n of [19, 20, 21]) {
  test(`E6 ${n} journaled dates waiting at workflow start (all repairable)`, () => {
    const fixtures = days(n).map((d, i) => ({ id: 6100 + i, league: 39, kickoff: `${d}T10:00:00.000Z` }));
    const r = run(`backlog${n}`, { fixtures, baselineDates: days(n), reportDates: [], preSql: ["UPDATE fixtures SET status_short='PST', status_long='Postponed' WHERE 1"] });
    console.log('E6 evidence', JSON.stringify({ n, status: r.status, error: r.error, adminCalls: r.calls.length, queueLeft: r.queue.length }));
    assert.equal(r.status, 0, `${n} repairable dates stopped the first workflow step`);
  });
}
test('E7 one date whose stored index lists an ID that D1 does not have, journaled by any header change', () => {
  const fixtures = [{ id: 6201, league: 39, kickoff: '2026-12-01T10:00:00.000Z' }, { id: 6202, league: 39, kickoff: '2026-12-02T10:00:00.000Z' }];
  const r = run('poison', { fixtures, baselineDates: ['2026-12-01', '2026-12-02'], reportDates: ['2026-12-01', '2026-12-02'], orphan: { date: '2026-12-01', id: 99999 },
    preSql: ["UPDATE fixtures SET status_short='PST', status_long='Postponed' WHERE 1"] });
  console.log('E7 evidence', JSON.stringify({ status: r.status, error: r.error, calls: r.calls.map(c => [c.status, c.result]), queue: r.queue }));
  // Hard repair reports the remaining poison date after still repairing the healthy date. Workflows use an explicit soft initial drain and retain the failed report.
  assert.equal(r.status, 1);
  assert.deepEqual(r.queue,['2026-12-01']);
  assert.deepEqual(r.r2Generic['2026-12-02'],['af:fixture:6202']);
  assert.equal(r.coverage['2026-12-02'],1);
});
