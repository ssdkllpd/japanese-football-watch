'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { planManualFixtureBackfill, publishedFixtureIds } = require('../scripts/v2/plan-manual-fixture-backfill');
const { checkManualBackfillBudget } = require('../scripts/v2/check-manual-backfill-budget');
const { recoveryDates } = require('../scripts/v2/manual-backfill-checkpoint');

const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..',
  'config/api-football-automation.json'), 'utf8'));
const now = new Date('2026-09-25T06:00:00Z');
const fixture = (id, league, status = 'FT', date = '2026-09-20T12:00:00Z') => ({
  fixture: { id, date, status: { short: status } }, league: { id: league, season: 2026 },
});
const budget = (ids = []) => ({ dateUtc: '2026-09-25', operation: 'fixture_publish_budget', fixtureIds: ids });
const inventory = ids => [{ success: true, results: ids.map(id => ({
  canonical_id: `af:fixture:${id}`, total: ids.length,
})) }];

function fakeClient(rowsByLeague, balance = 7000) {
  const calls = [];
  return {
    calls, lastQuota: null,
    async refreshDailyQuota() { this.lastQuota = { dailyRemaining: balance }; },
    async get(endpoint, params) {
      assert.equal(endpoint, 'fixtures');
      calls.push(params);
      this.lastQuota = { dailyRemaining: --balance };
      return { data: { response: rowsByLeague[params.league] || [fixture(
        100000 + params.league, params.league, 'NS', '2026-10-10T12:00:00Z',
      )], paging: { total: 1 } }, quota: this.lastQuota };
    },
  };
}

test('backfill plans only unpublished final fixtures through today, without refetching migration details', async () => {
  const client = fakeClient({
    39: [fixture(1, 39), fixture(2, 39, 'FT', '2026-09-24T12:00:00Z'),
      fixture(3, 39, 'NS', '2026-09-26T12:00:00Z')],
    78: [fixture(4, 78, 'FT', '2026-09-25T04:00:00Z')],
  });
  const plan = await planManualFixtureBackfill({
    policy, inventory: inventory([1]), dailyBudget: budget(), client, now, preview: true,
  });
  assert.equal(client.calls.length, 10);
  assert.deepEqual(plan.detailFetches.map(item => item.fixtureId), ['af:fixture:2']);
  assert.equal(plan.missingFixtureCount, 1);
  assert.equal(plan.deferredRecentCount, 1);
  assert.equal(plan.alreadyPublishedCount, 1);
  assert.equal(plan.standingsFetches.length, 10);
  assert.equal(plan.quota.estimatedProviderRequests, 26);
});

test('backfill is capped at 20 distinct publications per UTC day and resumes from D1 on the next run', async () => {
  const fixtures = Array.from({ length: 25 }, (_, index) => fixture(index + 1, 39));
  const args = { policy, inventory: inventory([]), dailyBudget: budget(),
    client: fakeClient({ 39: fixtures }), now, preview: false };
  const first = await planManualFixtureBackfill(args);
  assert.equal(first.detailFetches.length, 20);
  assert.equal(first.remainingAfterBatch, 5);
  const second = await planManualFixtureBackfill({ ...args, inventory: inventory(
    first.detailFetches.map(item => item.providerFixtureId),
  ), dailyBudget: budget(first.detailFetches.map(item => item.fixtureId)),
  client: fakeClient({ 39: fixtures }) });
  assert.equal(second.detailFetches.length, 0);
  assert.equal(second.remainingAfterBatch, 5);
  const nextDay = await planManualFixtureBackfill({ ...args,
    inventory: inventory(first.detailFetches.map(item => item.providerFixtureId)),
    dailyBudget: { ...budget(), dateUtc: '2026-09-26' },
    now: new Date('2026-09-26T06:00:00Z'), client: fakeClient({ 39: fixtures }),
  });
  assert.deepEqual(nextDay.detailFetches.map(item => item.providerFixtureId), [21, 22, 23, 24, 25]);
});

test('incomplete D1 inventory and malformed season discovery fail closed', async () => {
  assert.throws(() => publishedFixtureIds([{ results: [{ canonical_id: 'af:fixture:1', total: 2 }] }]),
    /incomplete/);
  await assert.rejects(() => planManualFixtureBackfill({
    policy, inventory: inventory([]), dailyBudget: budget(), now,
    client: fakeClient({ 39: [] }),
  }), /discovery is incomplete/);
});

test('budget change during fetch aborts publication before any R2 writes', async () => {
  const plan = await planManualFixtureBackfill({ policy, inventory: inventory([]),
    dailyBudget: budget(), now, client: fakeClient({ 39: [fixture(1, 39)] }) });
  assert.doesNotThrow(() => checkManualBackfillBudget(budget(), budget(), plan));
  assert.throws(() => checkManualBackfillBudget(budget(), budget(['af:fixture:42']), plan),
    /budget changed/);
  assert.throws(() => checkManualBackfillBudget(budget(), { ...budget(), dateUtc: '2026-09-26' }, plan),
    /budget changed/);
});

test('a partial Admin failure recovers indexes for only fixtures already published in D1', () => {
  const checkpoint = { schemaVersion: 'jfw-manual-backfill-checkpoint/1', status: 'pending',
    fixtures: [
      { fixtureId: 'af:fixture:1', dateJst: '2026-09-20' },
      { fixtureId: 'af:fixture:2', dateJst: '2026-09-21' },
      { fixtureId: 'af:fixture:3', dateJst: '2026-09-20' },
    ] };
  assert.deepEqual(recoveryDates(checkpoint, inventory([1, 3])), [{
    date: '2026-09-20', fixtureIds: ['af:fixture:1', 'af:fixture:3'],
  }]);
  assert.deepEqual(recoveryDates({ ...checkpoint, status: 'complete' }, inventory([1, 3])), []);
  assert.throws(() => recoveryDates({ ...checkpoint, fixtures: [
    checkpoint.fixtures[0], checkpoint.fixtures[0],
  ] }, inventory([1])), /invalid fixture metadata/);
});

test('manual workflow keeps a separate execution gate and read-only preview', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..',
    '.github/workflows/api-football-manual-backfill.yml'), 'utf8');
  assert.match(workflow, /group: d1-staging-write/);
  assert.match(workflow, /RUN API-FOOTBALL BACKFILL/);
  assert.match(workflow, /verify-d1-target\.mjs/);
  assert.match(workflow, /check-manual-backfill-budget\.js/);
  assert.match(workflow, /manual-backfill-checkpoint\.js recover/);
  assert.ok(workflow.indexOf('Checkpoint this batch before any fixture or index write')
    < workflow.indexOf('Reconcile and publish selected fixture bundles to R2'));
  for (const name of ['Reconcile and publish selected fixture bundles to R2',
    'Publish refreshed standings to R2', 'Publish through the protected Admin Worker and verify']) {
    const start = workflow.indexOf(`- name: ${name}`);
    assert.ok(start > 0);
    assert.match(workflow.slice(start, start + 150), /inputs\.mode == 'execute'/);
  }
});
