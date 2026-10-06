// Adapted regression tests; these results are not an independent review.
// Re-review (PR #123 b77d9cb): planner / executor boundaries. Scripted provider, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './helpers/schedule-r2-harness.mjs';

const require = createRequire(import.meta.url);
const { planScheduleSync } = require(path.join(ROOT, 'scripts/v2/plan-fixture-schedule-sync.js'));
const policy = require(path.join(ROOT, 'config/api-football-automation.json'));
const iso = ms => new Date(ms).toISOString();
const HOUR = 3600000; const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-06T00:00:00.000Z');
const FAR = iso(Date.parse('2027-03-01T10:00:00.000Z'));

function world({ perLeague = 342, kickoff = FAR } = {}) {
  const rows = []; const provider = new Map();
  for (const { league } of policy.competitionSeasons) {
    const list = [];
    for (let i = 0; i < perLeague; i += 1) {
      const id = league * 10000 + i;
      rows.push({ fixture_id: `af:fixture:${id}`, competition_id: `af:competition:${league}`, season_id: `af:season:${league}:2026`,
        kickoff_utc: kickoff, date_jst: iso(Date.parse(kickoff) + 9 * HOUR).slice(0, 10), status_short: 'NS', status_long: 'Not Started',
        status_elapsed: null, ingestion_state: 'scheduled', published_revision: null });
      list.push({ fixture: { id, date: kickoff, status: { short: 'NS' } }, league: { id: league, season: 2026 } });
    }
    provider.set(league, list);
  }
  return { rows, provider };
}
const inv = rows => [{ success: true, results: rows.map(r => ({ ...r, total: rows.length })) }];
function client(provider, { quota = 7000 } = {}) {
  let calls = 0;
  return { async refreshDailyQuota() { return { dailyRemaining: quota }; },
    async get(_n, p) { calls += 1; return { data: { response: provider.get(p.league), paging: { total: 1 } }, quota: { dailyRemaining: quota - calls } }; } };
}
const find = (w, id) => w.provider.get(Math.floor(id / 10000)).find(r => r.fixture.id === id);
const stored = (w, id) => w.rows.find(r => r.fixture_id === `af:fixture:${id}`);

test('Q01 twenty-five changes: the five kicking off in three hours are in the first batch of twenty', async () => {
  const w = world();
  const soon = iso(NOW + 3 * HOUR);
  for (let i = 0; i < 20; i += 1) find(w, 390100 + i).fixture.date = iso(Date.parse(FAR) + DAY);       // far-future shuffles
  const near = [];
  for (let i = 0; i < 5; i += 1) { stored(w, 940100 + i).kickoff_utc = iso(NOW + 5 * HOUR); find(w, 940100 + i).fixture.date = soon; near.push(`af:fixture:${940100 + i}`); }
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: NOW });
  const first = plan.changes.slice(0, 20).map(c => c.fixtureId);
  assert.equal(plan.changes.length, 25);
  assert.deepEqual(near.filter(id => first.includes(id)), near);
});

test('Q02 future kickoffs precede past-only corrections', async () => {
  const w = world();
  const past = iso(NOW - 20 * DAY);
  // 20 stale headers: stored NS at a past kickoff, provider now says PST / CANC (kickoff unchanged, in the past).
  for (let i = 0; i < 20; i += 1) { stored(w, 390200 + i).kickoff_utc = past; const p = find(w, 390200 + i); p.fixture.date = past; p.fixture.status.short = i % 2 ? 'PST' : 'CANC'; }
  // 3 imminent kickoff-time changes (5h -> 3h from now).
  const near = [];
  for (let i = 0; i < 3; i += 1) { stored(w, 940300 + i).kickoff_utc = iso(NOW + 5 * HOUR); find(w, 940300 + i).fixture.date = iso(NOW + 3 * HOUR); near.push(`af:fixture:${940300 + i}`); }
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: NOW });
  const first = plan.changes.slice(0, 20).map(c => c.fixtureId);
  console.log('Q02 evidence', JSON.stringify({ total: plan.changes.length, nearInFirstBatch: near.filter(id => first.includes(id)), firstBatchHead: first.slice(0, 3),
    positionsOfNear: near.map(id => plan.changes.findIndex(c => c.fixtureId === id)) }));
  // Independent expectation: a kickoff three hours away is handled in this run (the next scan is four hours later).
  assert.deepEqual(near.filter(id => first.includes(id)), near);
});

test('Q03 a severely incomplete season is refused before selecting writes', async () => {
  const w = world();
  w.provider.set(39, w.provider.get(39).slice(0, 1));               // 341 of 342 Premier League fixtures absent, paging.total = 1
  find(w, 400020).fixture.date = iso(Date.parse(FAR) + DAY);        // unrelated legitimate change
  let plan = null; let error = null;
  try { plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: NOW }); } catch (e) { error = e.message; }
  const missing = plan ? plan.held.filter(h => h.reason === 'provider_fixture_missing').length : null;
  console.log('Q03 evidence', JSON.stringify({ error, missing, changes: plan?.changes.length, scanned: plan?.scanned }));
  // A truncated season must fail before any update is selected.
  assert.match(error, /excessive missing fixtures/); assert.equal(plan, null);
});

test('Q04 normal execute accepts 241 and 500 changes; --all still refuses more than 240', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-q04-'));
  const run = (n, extra = []) => {
    const changes = Array.from({ length: n }, (_, i) => ({ schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_schedule_update', fixtureId: `af:fixture:${i + 1}` }));
    const file = path.join(dir, `plan-${n}.json`);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 'jfw-fixture-schedule-plan/1', changes, held: [] }));
    const r = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("offline-stub-fetch")}',
      path.join(ROOT, 'scripts/d1/execute-fixture-schedule-plan.mjs'), 'execute', file, ...extra], {
      env: { ...process.env, NODE_OPTIONS: '', ADMIN_INGEST_URL: 'https://127.0.0.1:9', ADMIN_INGEST_TOKEN: 'x', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'x' },
      encoding: 'utf8', timeout: 20000 });
    return (r.stderr.match(/Error: [^\n]*/) || [''])[0];
  };
  const out = { n241: run(241), n500: run(500), all240: run(240, ['--all']), all241: run(241, ['--all']) };
  console.log('Q04 evidence', JSON.stringify(out));
  assert.match(out.n241, /offline-stub-fetch/); assert.match(out.n500, /offline-stub-fetch/);   // passed validation, stopped at the stubbed network
  assert.match(out.all240, /offline-stub-fetch/); assert.match(out.all241, /Invalid schedule plan/);
});

test('Q05 the widened inventory (all stored fixtures) is filtered to the ten configured seasons', async () => {
  const w = world();
  w.rows.push({ fixture_id: 'af:fixture:4800001', competition_id: 'af:competition:48', season_id: 'af:season:48:2026', kickoff_utc: FAR,
    date_jst: '2027-03-01', status_short: 'NS', status_long: 'Not Started', status_elapsed: null, ingestion_state: 'scheduled', published_revision: null });
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: NOW });
  assert.equal(plan.scanned, 3420);
  assert.deepEqual(plan.held, []); assert.deepEqual(plan.changes, []);
});

test('Q06 published-detail hold now carries the stored/provider difference', async () => {
  const w = world();
  stored(w, 880010).published_revision = 77; stored(w, 880010).status_short = 'FT';
  const p = find(w, 880010); p.fixture.status.short = 'FT'; p.fixture.date = iso(Date.parse(FAR) + 15 * 60000);
  const plan = await planScheduleSync({ client: client(w.provider), inventory: inv(w.rows), now: NOW });
  assert.deepEqual(plan.held, [{ fixtureId: 'af:fixture:880010', reason: 'published_detail_requires_reconciliation',
    storedKickoffUtc: FAR, providerKickoffUtc: iso(Date.parse(FAR) + 15 * 60000), storedStatus: 'FT', providerStatus: 'FT' }]);
});
