// 15-minute automation interplay with schedule changes (real Admin publish path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, setup, baseline, update, r2Ids, pendingRows, fixtureRow, feedOrError, handleAdminIngest, dateIndexR2Key } from './helpers/schedule-harness.mjs';

const require = createRequire(import.meta.url);
const { writeFixtureEnvelope } = require(path.join(ROOT, 'scripts/v2/fetch-fixture-vertical-slice.js'));
const { createAutomationAdminPlan } = require(path.join(ROOT, 'scripts/d1/create-api-football-automation-admin-plan.js'));
const { planAutomation, checkpointAutomationDiscovery, emptyAutomationState } = require(path.join(ROOT, 'scripts/v2/api-football-automation-plan.js'));
const policy = require(path.join(ROOT, 'config/api-football-automation.json'));
const { executeAdminIngestPlan } = await import(path.join(ROOT, 'scripts/d1/request-admin-ingest.mjs'));
const { executeAutomationAdminPlan } = await import(path.join(ROOT, 'scripts/d1/execute-automation-admin-plan.mjs'));

function finalBundle(ctx, root, id, league, kickoff) {
  const raw = { fixture: { id, date: kickoff, status: { short: 'FT', long: 'Match Finished', elapsed: 90 } },
    league: { id: league, season: 2026, name: 'Premier League', country: 'England' },
    teams: { home: { id: 40, name: 'Home' }, away: { id: 50, name: 'Away' } },
    goals: { home: 1, away: 0 }, score: {}, events: [], lineups: [], players: [], statistics: [] };
  const dir = path.join(root, 'fixtures', String(id));
  writeFixtureEnvelope(dir, { fixture: raw, quota: {} }, { fetchedAt: '2026-10-04T06:00:00.000Z', finalized: true });
  const bundle = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
  ctx.objects.set(`football/v2/competitions/af:competition:${league}/seasons/af:season:${league}:2026/fixtures/af:fixture:${id}.json`, JSON.stringify(bundle));
  return raw;
}
const policyOn = { ...policy, scheduledSynchronizationEnabled: true };

test('publication drains A-to-B repair before a finished result relocates B-to-C', async () => {
  const ctx = setup([{ id: 3401, league: 39, kickoff: '2026-10-01T10:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.equal((await ctx.send(update(3401, 39, '2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z'))).status, 200);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-pending-relocation-'));
  finalBundle(ctx, root, 3401, 39, '2026-10-03T10:00:00.000Z');
  const plan = createAutomationAdminPlan({ schemaVersion: 'jfw-api-football-automation-plan/1',
    detailFetches: [{ providerFixtureId: 3401, fixtureId: 'af:fixture:3401', competitionId: 'af:competition:39',
      seasonId: 'af:season:39:2026', previousDateJst: '2026-10-02' }], standingsFetches: [] }, root, path.join(root, 'd1'));
  const report = await executeAdminIngestPlan(plan, { url: 'https://offline.test', token: 't', planDirectory: path.join(root, 'd1'),
    fetchImpl: (u, i) => handleAdminIngest(new Request(u, i), ctx.env) });
  assert.equal(report.passed, true);
  assert.deepEqual(pendingRows(ctx), []);
  assert.deepEqual(r2Ids(ctx, dateIndexR2Key('2026-10-01')), []);
  assert.deepEqual(r2Ids(ctx, dateIndexR2Key('2026-10-02')), []);
  assert.deepEqual(r2Ids(ctx, dateIndexR2Key('2026-10-03')), ['af:fixture:3401']);
  ctx.db.close();
});

test('a missing result object is quarantined while another result is published and verified', async () => {
  const ctx = setup([{ id: 3301, league: 39, kickoff: '2026-10-04T10:00:00.000Z' },
    { id: 3302, league: 39, kickoff: '2026-10-04T12:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-04']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-isolated-'));
  finalBundle(ctx, root, 3301, 39, '2026-10-04T10:00:00.000Z');
  finalBundle(ctx, root, 3302, 39, '2026-10-04T12:00:00.000Z');
  ctx.objects.delete('football/v2/competitions/af:competition:39/seasons/af:season:39:2026/fixtures/af:fixture:3301.json');
  const admin = createAutomationAdminPlan({ schemaVersion: 'jfw-api-football-automation-plan/1',
    detailFetches: [3301, 3302].map(id => ({ providerFixtureId: id, fixtureId: `af:fixture:${id}`,
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026' })), standingsFetches: [] }, root, path.join(root, 'd1'));
  const report = await executeAutomationAdminPlan(admin, { url: 'https://offline.test', token: 't',
    planDirectory: path.join(root, 'd1'), fetchImpl: (u, i) => handleAdminIngest(new Request(u, i), ctx.env) });
  assert.equal(report.passed, false);
  assert.deepEqual(report.successfulFixtures, ['af:fixture:3302']);
  assert.equal(fixtureRow(ctx, 3301).published_revision, null);
  assert.notEqual(fixtureRow(ctx, 3302).published_revision, null);
  assert.deepEqual(r2Ids(ctx, dateIndexR2Key('2026-10-04')), ['af:fixture:3301', 'af:fixture:3302']);
  ctx.db.close();
});

test('A01 D1 date snapshot declares relocation and the finalized result converges', async () => {
  const ctx = setup([{ id: 3001, league: 39, kickoff: '2026-10-03T14:00:00.000Z' }]); // JST 10-03 23:00
  await baseline(ctx, ['2026-10-03', '2026-10-04']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-a01-'));
  // Provider moved kickoff to 15:30Z (JST 10-04 00:30) after the 01:37 UTC daily sync; match finished.
  const raw = finalBundle(ctx, root, 3001, 39, '2026-10-03T15:30:00.000Z');
  const now = new Date('2026-10-04T00:00:00.000Z'); // 8.5 h after kickoff
  const fixturesByDate = { '2026-10-03': [], '2026-10-04': [raw], '2026-10-05': [] };
  let state = checkpointAutomationDiscovery(emptyAutomationState(),
    planAutomation({ policy: policyOn, state: emptyAutomationState(), fixturesByDate, now, quota: { dailyRemaining: 7000 },
      dailyBudget: { dateUtc: '2026-10-04', fixtureIds: [] },
      storedDates: [{ fixture_id: 'af:fixture:3001', date_jst: '2026-10-03' }] }));
  const runs = [];
  for (let run = 0; run < 3; run += 1) {
    const plan = planAutomation({ policy: policyOn, state, fixturesByDate: { '2026-10-03': [], '2026-10-04': [raw], '2026-10-05': [] },
      now, quota: { dailyRemaining: 7000 }, dailyBudget: { dateUtc: '2026-10-04', fixtureIds: [] },
      storedDates: [{ fixture_id: 'af:fixture:3001', date_jst: '2026-10-03' }] });
    const detail = plan.detailFetches.map(d => ({ fixtureId: d.fixtureId, previousDateJst: d.previousDateJst }));
    const admin = createAutomationAdminPlan({ schemaVersion: plan.schemaVersion,
      detailFetches: plan.detailFetches.map(d => ({ ...d })), standingsFetches: [] }, root, path.join(root, `d1-${run}`));
    let lastReject = null;
    const report = await executeAdminIngestPlan(admin, { url: 'https://offline.test', token: 't',
      planDirectory: path.join(root, `d1-${run}`), fetchImpl: async (u, i) => { const r = await handleAdminIngest(new Request(u, i), ctx.env);
        if (!r.ok) lastReject = (await r.clone().json()).detail; return r; } })
      .catch(e => ({ thrown: e.message }));

    runs.push({ detail, requireStableDate: admin.fixtures.map(f => f.requireStableDate === true),
      passed: report.passed, rejectDetail: lastReject, error: report.thrown || (JSON.stringify(report).match(/[A-Z][a-z]+ fixture changed its stored JST date[^"]*|"detail":"[^"]*"|"error":"[^"]*"/) || [JSON.stringify(report).slice(0,300)])[0] });
    // state only advances after success (workflow step order); keep state unchanged on failure
  }
  // Independent expectation: the finished fixture is eventually published on JST 2026-10-04.
  assert.notEqual(fixtureRow(ctx, 3001).published_revision, null);
});

test('A02 provider kickoff correction does not invalidate retained identity', () => {
  const raw = { fixture: { id: 3101, date: '2026-10-03T14:00:00Z', status: { short: 'FT' } }, league: { id: 39, season: 2026 } };
  const now = new Date('2026-10-04T00:00:00.000Z');
  const dates = { '2026-10-03': [raw], '2026-10-04': [], '2026-10-05': [] };
  const common = { policy: policyOn, now, quota: { dailyRemaining: 7000 }, dailyBudget: { dateUtc: '2026-10-04', fixtureIds: [] },
      storedDates: [{ fixture_id: 'af:fixture:3001', date_jst: '2026-10-03' }] };
  const state = checkpointAutomationDiscovery(emptyAutomationState(), planAutomation({ ...common, state: emptyAutomationState(), fixturesByDate: dates }));
  const corrected = structuredClone(raw); corrected.fixture.date = '2026-10-03T14:15:00Z';
  let error = null;
  try { planAutomation({ ...common, state, fixturesByDate: { ...dates, '2026-10-03': [corrected] } }); } catch (e) { error = e.message; }
  assert.equal(error, null, 'one kickoff correction stops all automation work');
});

test('A03 pending repair converges after the real result-publication path', async () => {
  const ctx = setup([{ id: 3201, league: 39, kickoff: '2026-10-03T10:00:00.000Z' }, { id: 3202, league: 39, kickoff: '2026-10-09T10:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-03', '2026-10-04', '2026-10-09', '2026-10-10']);
  // Daily sync: D1 updated to 10-04, repair did not run (job timeout / cancelled).
  assert.equal((await ctx.send(update(3201, 39, '2026-10-03T10:00:00.000Z', '2026-10-04T10:00:00.000Z'))).status, 200);
  // 15-minute automation (or bounded catch-up) publishes the finished match.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-a03-'));
  finalBundle(ctx, root, 3201, 39, '2026-10-04T10:00:00.000Z');
  const admin = createAutomationAdminPlan({ schemaVersion: 'jfw-api-football-automation-plan/1',
    detailFetches: [{ providerFixtureId: 3201, fixtureId: 'af:fixture:3201', competitionId: 'af:competition:39', seasonId: 'af:season:39:2026' }],
    standingsFetches: [] }, root, path.join(root, 'd1'));
  const report = await executeAdminIngestPlan(admin, { url: 'https://offline.test', token: 't', planDirectory: path.join(root, 'd1'),
    fetchImpl: (u, i) => handleAdminIngest(new Request(u, i), ctx.env) }).catch(e => ({ thrown: e.message }));
  const repairs = [];
  for (let i = 0; i < 3; i += 1) repairs.push(await ctx.send({ operation: 'fixture_schedule_repair' }));
  const other = await ctx.send(update(3202, 39, '2026-10-09T10:00:00.000Z', '2026-10-10T10:00:00.000Z'));
  // Independent expectation: old date no longer lists the fixture and schedule sync can continue.
  assert.deepEqual(r2Ids(ctx, dateIndexR2Key('2026-10-03')), []);
  assert.equal(other.status, 200);
});
