// Planner / executor boundary reproduction with a scripted provider client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './helpers/schedule-harness.mjs';

const require = createRequire(import.meta.url);
const { planScheduleSync } = require(path.join(ROOT, 'scripts/v2/plan-fixture-schedule-sync.js'));
const policy = require(path.join(ROOT, 'config/api-football-automation.json'));

// Build a 3,420-row inventory (342 per league) all NS at a fixed kickoff.
function world({ perLeague = 342, kickoff = '2026-10-10T10:00:00.000Z' } = {}) {
  const rows = []; const provider = new Map();
  for (const { league } of policy.competitionSeasons) {
    const list = [];
    for (let i = 0; i < perLeague; i += 1) {
      const id = league * 10000 + i;
      rows.push({ fixture_id: `af:fixture:${id}`, competition_id: `af:competition:${league}`,
        season_id: `af:season:${league}:2026`, kickoff_utc: kickoff, status_short: 'NS', published_revision: null });
      list.push({ fixture: { id, date: kickoff, status: { short: 'NS' } }, league: { id: league, season: 2026 } });
    }
    provider.set(league, list);
  }
  for (const r of rows) r.total = rows.length;
  return { rows, provider };
}
function client(provider, { quota = 7000, paging = () => 1, fail = null } = {}) {
  let calls = 0;
  return { calls: () => calls,
    async refreshDailyQuota() { return { dailyRemaining: quota }; },
    async get(_n, p) { calls += 1; if (fail && fail(p.league)) throw fail(p.league);
      return { data: { response: provider.get(p.league), paging: { total: paging(p.league) } }, quota: { dailyRemaining: quota - calls } }; } };
}
const inv = rows => [{ success: true, results: rows }];
const find = (w, id) => w.provider.get(Math.floor(id / 10000)).find(r => r.fixture.id === id);

test('P01 cancellation, abandonment and suspended headers are propagated; rich results are held', async () => {
  const w = world();
  const cases = { 390001: 'CANC', 390002: 'ABD', 390003: 'AWD', 390004: 'WO', 390005: 'FT', 390006: '1H', 390007: 'SUSP', 390008: 'INT' };
  for (const [id, st] of Object.entries(cases)) find(w, Number(id)).fixture.status.short = st;
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' });
  assert.equal(plan.changes.length, 6);
  assert.deepEqual(plan.held.map(h => h.reason), Array(2).fill('non_schedule_status'));
});

test('P02 PST with a placeholder kickoff produces BOTH a change (old kickoff kept) and a hold', async () => {
  const w = world();
  const row = find(w, 400010); row.fixture.status.short = 'PST'; row.fixture.date = '2026-12-31T00:00:00+00:00';
  const tbd = find(w, 400011); tbd.fixture.status.short = 'TBD'; tbd.fixture.date = '2026-10-17T00:00:00+00:00';
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' });
  assert.deepEqual(plan.changes.map(c => c.fixtureId), ['af:fixture:400010', 'af:fixture:400011']);
  assert.ok(plan.changes.every(c => c.newKickoffUtc === '2026-10-10T10:00:00.000Z'));
  // TBD (date known, time open) is kept on the OLD date until NS: by spec, not an error.
});

test('P03 the nearest kickoffs are selected before later changes', async () => {
  const w = world();
  // 25 changes. The 5 with the nearest kickoff have lexically largest IDs.
  const ids = [];
  for (let i = 0; i < 20; i += 1) ids.push([390100 + i, '2026-11-20T10:00:00.000Z']);
  for (let i = 0; i < 5; i += 1) ids.push([940100 + i, '2026-10-01T10:00:00.000Z']); // league 94 -> 'af:fixture:94...' sorts after 'af:fixture:39...'
  for (const [id, k] of ids) find(w, id).fixture.date = k;
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' });
  const firstBatch = plan.changes.slice(0, 20).map(c => c.fixtureId); // executor: plan.changes.slice(0, 20)
  const nearest = ids.slice(20).map(([id]) => `af:fixture:${id}`);
  // Independent expectation: nearest-kickoff changes should not be deferred behind later ones.
  assert.deepEqual(nearest.filter(id => firstBatch.includes(id)), nearest);
});

test('P04 normal execution applies twenty from a 241-change plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-exec-'));
  const run = n => {
    const changes = Array.from({ length: n }, (_, i) => ({ schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_schedule_update', fixtureId: `af:fixture:${i + 1}` }));
    const file = path.join(dir, `plan-${n}.json`);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 'jfw-fixture-schedule-plan/1', changes, held: [] }));
    return spawnSync(process.execPath, ['--import', 'data:text/javascript,let last=null;globalThis.fetch=async(url,init)=>{if(String(url).includes("api.cloudflare.com"))return new Response(JSON.stringify({data:{viewer:{accounts:[{d1AnalyticsAdaptiveGroups:[]}]}}}));const r=JSON.parse(init.body);if(r.fixtureId)last=r.fixtureId;return new Response(JSON.stringify({ok:true,report:{repaired:last}}))}', path.join(ROOT, 'scripts/d1/execute-fixture-schedule-plan.mjs'), 'execute', file], {
      env: { ...process.env, ADMIN_INGEST_URL: 'https://127.0.0.1:9', ADMIN_INGEST_TOKEN: 'x',
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'x' }, encoding: 'utf8', timeout: 20000 });
  };
  const r240 = run(240); const r241 = run(241);
  const msg = r => (r.stderr.match(/Error: [^\n]*/) || [''])[0];
  assert.doesNotMatch(msg(r241), /Invalid schedule plan/);            // 241 aborts before any write
  assert.doesNotMatch(msg(r240), /Invalid schedule plan/);     // 240 proceeds to capacity check / network
  // Independent expectation: normal mode processes 20 and leaves the rest for later scans.
  assert.equal(r241.status, 0, r241.stderr);
  assert.deepEqual(JSON.parse(r241.stdout), { updated: 20, remaining: 221, held: 0 });
});

test('P05 a missing provider fixture is held while unrelated changes continue', async () => {
  const w = world();
  w.provider.get(39).splice(5, 1);                  // provider dropped / replaced one fixture ID
  find(w, 400020).fixture.date = '2026-10-12T10:00:00.000Z'; // an unrelated legitimate change
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' });
  assert.ok(plan.held.some(item => item.fixtureId === 'af:fixture:390005' && item.reason === 'provider_fixture_missing'));
  assert.ok(plan.changes.some(item => item.fixtureId === 'af:fixture:400020'));
});

test('P06 paging, empty, quota and 429/5xx all fail closed before any write', async () => {
  const w = world();
  await assert.rejects(planScheduleSync({ client: client(w.provider, { paging: l => (l === 61 ? 2 : 1) }), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' }), /incomplete/);
  const empty = world(); empty.provider.set(78, []);
  await assert.rejects(planScheduleSync({ client: client(empty.provider), inventory: inv(empty.rows) }), /incomplete/);
  await assert.rejects(planScheduleSync({ client: client(w.provider, { quota: 110 }), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' }), /quota/);
  await assert.rejects(planScheduleSync({ client: client(w.provider, { fail: l => (l === 135 ? new Error('HTTP 429') : null) }), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' }), /429/);
  // quota ends below reserve (100): 111 start, 10 calls
  await assert.rejects(planScheduleSync({ client: client(w.provider, { quota: 105 }), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' }), /quota/);
});

test('P07 a complete configured inventory below 3000 rows can be scanned', async () => {
  const w = world({ perLeague: 299 });
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' });
  assert.equal(plan.scanned, 2990);
});

test('P08 new provider ID is only held; duplicate across leagues and scope change fail closed', async () => {
  const w = world();
  w.provider.get(39).push({ fixture: { id: 399999, date: '2026-10-10T10:00:00Z', status: { short: 'NS' } }, league: { id: 39, season: 2026 } });
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' });
  assert.deepEqual(plan.held, [{ fixtureId: 'af:fixture:399999', reason: 'new_fixture_requires_catalog' }]);
  const d = world(); d.provider.get(40).push(structuredClone(d.provider.get(39)[0])); d.provider.get(40).at(-1).league.id = 40;
  await assert.rejects(planScheduleSync({ client: client(d.provider), inventory: inv(d.rows) }), /duplicated|scope/);
});

test('P09 timezone notation: +01:00 provider offsets and epoch comparison', async () => {
  const w = world();
  find(w, 610001).fixture.date = '2026-10-10T11:00:00+01:00'; // same instant -> no change
  find(w, 610002).fixture.date = '2026-10-25T02:30:00+02:00'; // CEST end day -> 00:30Z
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: '2026-09-30T03:00:00Z' });
  assert.deepEqual(plan.changes.map(c => [c.fixtureId, c.newKickoffUtc]), [['af:fixture:610002', '2026-10-25T00:30:00.000Z']]);
});
