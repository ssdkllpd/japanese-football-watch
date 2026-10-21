'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  advanceAutomationState,
  checkpointAutomationDiscovery,
  discoveryDates,
  emptyAutomationState,
  planAutomation,
  plannedDiscoveryDates,
  startAutomationDiscovery,
  validatePolicy,
} = require('../scripts/v2/api-football-automation-plan');

const root = path.join(__dirname, '..');
const policy = () => JSON.parse(fs.readFileSync(
  path.join(root, 'config', 'api-football-automation.json'), 'utf8',
));

function fixture(id, league, status, kickoff, season = 2026) {
  return {
    fixture: { id, date: kickoff, status: { short: status } },
    league: { id: league, season },
  };
}

function input(rows, now = '2026-09-17T12:00:00.000Z', customPolicy = policy()) {
  const dates = discoveryDates(customPolicy, now);
  return {
    policy: customPolicy,
    state: emptyAutomationState(),
    now,
    quota: { dailyRemaining: 7000 },
    preview: true,
    fixturesByDate: Object.fromEntries(dates.map(date => [date, rows[date] || []])),
  };
}

test('reviewed automation policy permits activation within unchanged limits', () => {
  const value = validatePolicy(policy());
  assert.equal(value.scheduledSynchronizationEnabled, true);
  assert.equal(value.competitionSeasons.length, 24);
  assert.equal(value.limits.maxFinalDetailFixturesPerRun, 20);
  assert.equal(value.limits.maxFinalDetailFixturesPerDay, 40);
  assert.equal(value.limits.maxCorrectionFixturesPerDay, 8);
});

test('planner includes only reviewed competition-season identities and finalized fixtures', () => {
  const rows = {
    '2026-09-17': [
      fixture(1, 39, 'FT', '2026-09-17T06:00:00Z'),
      fixture(2, 78, '2H', '2026-09-17T06:00:00Z'),
      fixture(3, 98, 'FT', '2026-09-17T06:00:00Z'),
      fixture(4, 39, 'FT', '2026-09-17T06:00:00Z', 2025),
    ],
  };
  const plan = planAutomation(input(rows));
  assert.deepEqual(plan.detailFetches.map(item => item.fixtureId), ['af:fixture:1']);
  assert.equal(plan.excludedFixtureCount, 2);
  assert.deepEqual(plan.standingsFetches.map(item => item.league), [2, 3, 39, 40, 61, 78, 88, 94, 135, 140]);
});

test('disabled policy produces no side effects unless explicitly previewed', () => {
  const rows = { '2026-09-17': [fixture(1, 39, 'FT', '2026-09-17T06:00:00Z')] };
  const args = input(rows);
  args.preview = false;
  args.policy.scheduledSynchronizationEnabled = false;
  const plan = planAutomation(args);
  assert.equal(plan.mode, 'disabled');
  assert.deepEqual(plan.detailFetches, []);
  assert.deepEqual(plan.standingsFetches, []);
});

test('final fixture correction stages become due at 0, 6, 24 and 72 hours without replay', () => {
  const rows = { '2026-09-17': [fixture(1, 39, 'FT', '2026-09-17T06:00:00Z')] };
  const args = input(rows, '2026-09-17T12:00:00.000Z');
  let plan = planAutomation(args);
  assert.equal(plan.detailFetches[0].recheckStage, 'initial');
  args.state = advanceAutomationState(args.state, plan, '2026-09-17T12:01:00Z');
  assert.equal(args.state.fixtures['af:fixture:1'].kickoffUtc, '2026-09-17T06:00:00.000Z');

  Object.assign(args, input({}, '2026-09-17T16:00:00.000Z'), { state: args.state });
  plan = planAutomation(args);
  assert.equal(plan.detailFetches.length, 0);
  Object.assign(args, input({}, '2026-09-18T00:00:00.000Z'), { state: args.state });
  plan = planAutomation(args);
  assert.equal(plan.detailFetches[0].recheckStage, 'correction_6h');
  args.state = advanceAutomationState(args.state, plan, '2026-09-18T00:01:00Z');

  Object.assign(args, input({}, '2026-09-18T10:00:00.000Z'), { state: args.state });
  plan = planAutomation(args);
  assert.equal(plan.detailFetches.length, 0);
  Object.assign(args, input({}, '2026-09-19T00:00:00.000Z'), { state: args.state });
  plan = planAutomation(args);
  assert.equal(plan.detailFetches[0].recheckStage, 'correction_24h');
  args.state = advanceAutomationState(args.state, plan, '2026-09-19T00:01:00Z');

  Object.assign(args, input({}, '2026-09-20T10:00:00.000Z'), { state: args.state });
  plan = planAutomation(args);
  assert.equal(plan.detailFetches[0].recheckStage, 'correction_72h');
  assert.equal(plan.retainedFixtureCount, 1);
  args.state = advanceAutomationState(args.state, plan, '2026-09-20T10:01:00Z');
  assert.equal(planAutomation(args).detailFetches.length, 0);
});

test('planner enforces the 20-fixture hard cap and deterministic kickoff/id ordering', () => {
  const rows = { '2026-09-17': Array.from({ length: 25 }, (_, index) => fixture(
    100 + index, 39, 'FT', `2026-09-17T0${index % 9}:00:00Z`,
  )) };
  const plan = planAutomation(input(rows));
  assert.equal(plan.detailFetches.length, 20);
  assert.deepEqual(plan.detailFetches.map(item => item.fixtureId),
    [...plan.detailFetches.map(item => item.fixtureId)].sort((left, right) => {
      const leftItem = plan.detailFetches.find(item => item.fixtureId === left);
      const rightItem = plan.detailFetches.find(item => item.fixtureId === right);
      return leftItem.kickoffUtc.localeCompare(rightItem.kickoffUtc) || left.localeCompare(right);
    }));
});

test('D1 daily receipts bound successive runs and allow the next UTC day', () => {
  const rows = { '2026-09-17': Array.from({ length: 45 }, (_, index) =>
    fixture(100 + index, 39, 'FT', '2026-09-17T06:00:00Z')) };
  const args = input(rows);
  const enabled = { ...policy(), scheduledSynchronizationEnabled: true };
  args.policy = enabled;
  args.preview = false;
  args.dailyBudget = { dateUtc: '2026-09-17', fixtureIds: [], automationFixtureIds: [], manualFixtureIds: [], remaining: 240 };
  const first = planAutomation(args);
  assert.equal(first.detailFetches.length, 20);
  args.dailyBudget.fixtureIds = first.detailFetches.map(item => item.fixtureId);
  args.dailyBudget.automationFixtureIds = [...args.dailyBudget.fixtureIds];
  args.dailyBudget.remaining = 220;
  assert.deepEqual(planAutomation(args).detailFetches.map(item => item.fixtureId),
    first.detailFetches.map(item => item.fixtureId)); // recovery of already published details
  args.state = advanceAutomationState(checkpointAutomationDiscovery(args.state, first), first,
    '2026-09-17T12:01:00Z');
  const second = planAutomation(args);
  assert.equal(second.detailFetches.length, 20);
  args.dailyBudget.fixtureIds.push(...second.detailFetches.map(item => item.fixtureId));
  args.dailyBudget.automationFixtureIds = [...args.dailyBudget.fixtureIds];
  args.dailyBudget.remaining = 200;
  args.state = advanceAutomationState(args.state, second, '2026-09-17T12:02:00Z');
  assert.equal(planAutomation(args).detailFetches.length, 0);
  const next = input({}, '2026-09-18T12:00:00.000Z', enabled);
  next.preview = false;
  next.state = args.state;
  next.dailyBudget = { dateUtc: '2026-09-18', fixtureIds: [], automationFixtureIds: [], manualFixtureIds: [], remaining: 240 };
  const nextDay = planAutomation(next);
  assert.equal(nextDay.detailFetches.filter(item => item.recheckStage === 'initial').length, 5);
  assert.equal(nextDay.detailFetches.filter(item => item.recheckStage !== 'initial').length, 8);
  assert.equal(nextDay.detailFetches.length, 13);
});

test('unfinished discovery remains anchored across JST midnight and advances in bounded batches', () => {
  const before = startAutomationDiscovery(emptyAutomationState(), policy(), '2026-09-17T14:59:00Z');
  assert.equal(before.pendingDiscoveryDate, '2026-09-16');
  assert.deepEqual(plannedDiscoveryDates(policy(), before, '2026-09-17T15:01:00Z'),
    ['2026-09-16', '2026-09-17', '2026-09-18']);
  const after = input({}, '2026-09-17T15:01:00Z');
  after.state = before;
  after.fixturesByDate = Object.fromEntries(plannedDiscoveryDates(policy(), before, after.now)
    .map(date => [date, date === '2026-09-16'
      ? [fixture(9001, 39, 'FT', '2026-09-16T06:00:00Z')] : []]));
  const plan = planAutomation(after);
  assert.equal(plan.detailFetches[0].fixtureId, 'af:fixture:9001');
  const checkpoint = checkpointAutomationDiscovery(before, plan);
  assert.equal(checkpoint.pendingDiscoveryDate, '2026-09-19');
  assert.deepEqual(plannedDiscoveryDates(policy(), checkpoint, '2026-09-17T15:01:00Z'),
    ['2026-09-19']);
});

test('discovery checkpoint retains unselected fixtures and failed details beyond the JST window', () => {
  const before = input({
    '2026-09-16': [fixture(9001, 39, 'FT', '2026-09-16T12:00:00Z')],
  }, '2026-09-17T14:45:00Z');
  const selected = planAutomation(before);
  assert.deepEqual(selected.detailFetches.map(item => item.fixtureId), ['af:fixture:9001']);
  const checkpoint = checkpointAutomationDiscovery(before.state, selected);
  assert.deepEqual(checkpoint.fixtures['af:fixture:9001'].completedStages, []);
  assert.equal(checkpoint.fixtures['af:fixture:9001'].lastDetailFetchedAt, null);
  const after = input({}, '2026-09-17T15:00:00Z');
  after.state = checkpoint;
  assert.deepEqual(planAutomation(after).detailFetches.map(item => item.fixtureId), ['af:fixture:9001']);
});

test('quota reserve reduces work rather than crossing the protected remaining count', () => {
  const rows = { '2026-09-17': [
    fixture(1, 39, 'FT', '2026-09-17T06:00:00Z'),
    fixture(2, 78, 'FT', '2026-09-17T06:01:00Z'),
  ] };
  const args = input(rows);
  args.quota.dailyRemaining = 105;
  const plan = planAutomation(args);
  assert.equal(plan.detailFetches.length, 1);
  assert.equal(plan.standingsFetches.length, 0);
  assert.equal(plan.quota.estimatedProviderRequests, 9);
});

test('standings refresh independently every six hours, including matchless leagues', () => {
  const args = input({});
  let plan = planAutomation(args);
  assert.equal(plan.detailFetches.length, 0);
  assert.equal(plan.standingsFetches.length, 10);
  args.state = advanceAutomationState(args.state, plan, '2026-09-17T12:01:00Z');

  const remaining=planAutomation(args);
  assert.deepEqual(remaining.standingsFetches.map(s=>s.league),[144,179,848]);
  args.state=advanceAutomationState(args.state,remaining,'2026-09-17T12:02:00Z');
  Object.assign(args, input({}, '2026-09-17T17:59:00Z'), { state: args.state });
  assert.equal(planAutomation(args).standingsFetches.length, 0);
  Object.assign(args, input({}, '2026-09-17T18:02:00Z'), { state: args.state });
  assert.equal(planAutomation(args).standingsFetches.length, 10);
});

test('planner rejects duplicate provider fixtures and policy drift', () => {
  const duplicate = input({ '2026-09-17': [
    fixture(1, 39, 'FT', '2026-09-17T06:00:00Z'),
    fixture(1, 39, 'FT', '2026-09-17T06:00:00Z'),
  ] });
  assert.throws(() => planAutomation(duplicate), /duplicated af:fixture:1/);
  const drifted = policy();
  drifted.limits.maxFinalDetailFixturesPerRun = 21;
  assert.throws(() => validatePolicy(drifted), /hard cap of 20/);
  const unknown = policy();
  unknown.unreviewed = true;
  assert.throws(() => validatePolicy(unknown), /must contain exactly/);
  const changedScope = policy();
  changedScope.competitionSeasons[0].league = 9999;
  assert.throws(() => validatePolicy(changedScope), /reviewed 2026 scope/);
  const changedRecheck = policy();
  changedRecheck.finalDetailRechecks[3].afterHours = 96;
  assert.throws(() => validatePolicy(changedRecheck), /reviewed 0\/6\/24\/72-hour/);
});

test('retained fixture state rejects identity drift and unknown fields', () => {
  const args = input({ '2026-09-17': [fixture(1, 39, 'FT', '2026-09-17T06:00:00Z')] });
  const first = planAutomation(args);
  args.state = advanceAutomationState(args.state, first, '2026-09-17T12:01:00Z');
  args.fixturesByDate['2026-09-17'] = [fixture(1, 78, 'FT', '2026-09-17T06:00:00Z')];
  assert.throws(() => planAutomation(args), /changed retained identity/);

  const poisoned = structuredClone(args.state);
  poisoned.fixtures['af:fixture:1'].unexpected = true;
  assert.throws(() => planAutomation({ ...args, state: poisoned }), /must contain exactly/);
  const skippedStage = structuredClone(args.state);
  skippedStage.fixtures['af:fixture:1'].completedStages = ['correction_6h'];
  assert.throws(() => planAutomation({ ...args, state: skippedStage }), /must be a prefix/);
});

test('planner refuses automated work when the provider quota header is unavailable', () => {
  const args = input({});
  args.quota = {};
  assert.throws(() => planAutomation(args), /daily remaining quota is required/);
  args.preview = false;
  args.policy.scheduledSynchronizationEnabled = false;
  assert.equal(planAutomation(args).mode, 'disabled');
});

test('105 manual publications do not consume automatic daily capacity, and manual same-day checks count as automatic work', () => {
  const args = input({ '2026-09-17': Array.from({ length: 21 }, (_, i) =>
    fixture(1000 + i, 39, 'FT', '2026-09-17T06:00:00Z')) });
  const manual = Array.from({ length: 105 }, (_, i) => `af:fixture:${1000 + i}`);
  args.dailyBudget = { dateUtc: '2026-09-17', fixtureIds: manual,
    manualFixtureIds: manual, automationFixtureIds: [], remaining: 135 };
  const first = planAutomation(args);
  assert.equal(first.detailFetches.length, 20);
  assert.equal(first.quota.fixturePublishesRemaining, 20);
  assert.equal(first.quota.globalFixturePublishesRemaining, 135);
  assert.equal(first.quota.manualFixturesPublishedToday, 105);
  assert.equal(first.publicationSource, 'automation');
  args.state = advanceAutomationState(args.state, first, '2026-09-17T12:01:00Z');
  const second = planAutomation(args);
  assert.equal(second.detailFetches.length, 1);
  assert.equal(second.quota.fixturePublishesRemaining, 19);
});

test('automatic receipts survive a failed state write and the global cap remains independent', () => {
  const args = input({ '2026-09-17': [fixture(999, 39, 'FT', '2026-09-17T06:00:00Z')] });
  const automatic = Array.from({ length: 40 }, (_, i) => `af:fixture:${i + 1}`);
  args.dailyBudget = { dateUtc: '2026-09-17', fixtureIds: automatic,
    automationFixtureIds: automatic, manualFixtureIds: [], remaining: 200 };
  assert.equal(planAutomation(args).detailFetches.length, 0);
  const manual = Array.from({ length: 240 }, (_, i) => `af:fixture:${i + 1}`);
  args.dailyBudget = { dateUtc: '2026-09-17', fixtureIds: manual,
    automationFixtureIds: [], manualFixtureIds: manual, remaining: 0 };
  assert.equal(planAutomation(args).detailFetches.length, 0);
  args.dailyBudget.remaining = 1;
  assert.throws(() => planAutomation(args), /budget/);
  delete args.dailyBudget.automationFixtureIds;
  assert.throws(() => planAutomation(args), /source receipts/);
  const p = policy();
  p.limits.maxFinalDetailFixturesPerDay = 41;
  assert.throws(() => validatePolicy(p), /daily cap of 40/);
});

test('source partitions cannot omit, duplicate or invent published fixtures', () => {
  const { validatePublicationBudget } = require('../scripts/d1/fixture-publication-budget');
  const b = { dateUtc: '2026-10-15', fixtureIds: ['af:fixture:1'], remaining: 239,
    automationFixtureIds: [], manualFixtureIds: ['af:fixture:1'] };
  assert.doesNotThrow(() => validatePublicationBudget(b, '2026-10-15'));
  assert.throws(() => validatePublicationBudget({ ...b, manualFixtureIds: [] }, b.dateUtc), /partition/);
  assert.throws(() => validatePublicationBudget({ ...b, automationFixtureIds: ['af:fixture:1'] }, b.dateUtc), /partition/);
  assert.throws(() => validatePublicationBudget({ ...b, manualFixtureIds: ['af:fixture:2'] }, b.dateUtc), /partition/);
});

test('cups and leagues share the same final-detail budget; domestic knockout cups never request standings',()=>{
 const rows=policy().competitionSeasons.map((scope,index)=>fixture(9000+index,scope.league,index%2?'PEN':'AET','2026-09-17T06:00:00Z'));
 const args=input({'2026-09-17':rows}),plan=planAutomation(args);
 assert.equal(plan.detailFetches.length,20);
 assert.ok(plan.detailFetches.some(f=>f.league===2));assert.ok(plan.detailFetches.some(f=>f.league===39));
 const ids=new Set(require('../config/cup-competitions.json').competitions.filter(c=>!c.standings).map(c=>c.providerId));
 assert.ok(plan.standingsFetches.every(s=>!ids.has(s.league)));
 args.state=advanceAutomationState(args.state,plan,args.now);
 const second=planAutomation(args);assert.equal(second.detailFetches.length,4);
 args.state=advanceAutomationState(args.state,second,args.now);
 assert.equal(planAutomation(args).detailFetches.length,0);
});
