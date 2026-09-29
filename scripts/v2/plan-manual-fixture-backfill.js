'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClientFromEnv } = require('../api-football/client');
const {
  PLAN_VERSION, canonicalFixture, dateJst, validatePolicy,
} = require('./api-football-automation-plan');

const FINAL_STATUSES = new Set(['FT', 'AET', 'PEN']);
// The shared 240-fixture ledger is an application ceiling, not the D1 Free
// rows-written budget. The reviewed D1 model reserves 20 detail writes/day.
const MAX_DAILY_DETAIL_PUBLISHES = 20;

function publishedFixtureIds(inventory) {
  if (!Array.isArray(inventory) || inventory.length !== 1 || inventory[0]?.success === false
    || !Array.isArray(inventory[0]?.results)) {
    throw new Error('D1 published fixture inventory is missing or failed.');
  }
  const rows = inventory[0].results;
  const expected = rows.length ? rows[0].total : 0;
  if (!Number.isSafeInteger(expected) || expected !== rows.length) {
    throw new Error('D1 published fixture inventory is incomplete.');
  }
  const ids = new Set();
  for (const row of rows) {
    if (row.total !== expected || !/^af:fixture:\d+$/.test(row.canonical_id)
      || ids.has(row.canonical_id)) {
      throw new Error('D1 published fixture inventory has an invalid or duplicate identity.');
    }
    ids.add(row.canonical_id);
  }
  return ids;
}

function storedFixtureDates(inventory) {
  if (!Array.isArray(inventory) || inventory.length !== 1 || inventory[0]?.success === false
    || !Array.isArray(inventory[0]?.results)) {
    throw new Error('D1 stored fixture date inventory is missing or failed.');
  }
  const rows = inventory[0].results;
  const expected = rows.length ? rows[0].total : 0;
  if (!Number.isSafeInteger(expected) || expected !== rows.length) {
    throw new Error('D1 stored fixture date inventory is incomplete.');
  }
  const dates = new Map();
  for (const row of rows) {
    const date = row.date_jst;
    if (row.total !== expected || !/^af:fixture:\d+$/.test(row.canonical_id)
      || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
      || dates.has(row.canonical_id)) {
      throw new Error('D1 stored fixture date inventory has invalid or duplicate metadata.');
    }
    dates.set(row.canonical_id, date);
  }
  return dates;
}

async function planManualFixtureBackfill({ policy, inventory, dateInventory, dailyBudget, client,
  now = new Date(), preview = true }) {
  validatePolicy(policy);
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new Error('Backfill time is invalid.');
  const todayJst = dateJst(nowDate);
  const todayUtc = nowDate.toISOString().slice(0, 10);
  if (dailyBudget?.dateUtc !== todayUtc || !Array.isArray(dailyBudget.fixtureIds)
    || dailyBudget.fixtureIds.length > 240
    || dailyBudget.remaining !== 240 - dailyBudget.fixtureIds.length
    || new Set(dailyBudget.fixtureIds).size !== dailyBudget.fixtureIds.length
    || dailyBudget.fixtureIds.some(id => !/^af:fixture:\d+$/.test(id))) {
    throw new Error('D1 daily publication budget is missing or stale.');
  }
  const published = publishedFixtureIds(inventory);
  const storedDates = storedFixtureDates(dateInventory);
  const scopes = new Set(policy.competitionSeasons.map(scope => `${scope.league}:${scope.season}`));
  const known = new Set();
  const missing = [];
  let finalCount = 0;
  let deferredRecentCount = 0;
  let nonFinalCount = 0;
  await client.refreshDailyQuota();
  for (const scope of policy.competitionSeasons) {
    const response = await client.get('fixtures', {
      league: scope.league, season: scope.season, timezone: policy.timeZone,
    });
    if (!Array.isArray(response.data?.response) || response.data.response.length === 0
      || Number(response.data?.paging?.total ?? 1) !== 1) {
      throw new Error(`Season fixture discovery is incomplete: ${scope.league}:${scope.season}.`);
    }
    for (const row of response.data.response) {
      const fixture = canonicalFixture(row);
      if (!fixture || !scopes.has(`${fixture.league}:${fixture.season}`)
        || fixture.league !== scope.league || fixture.season !== scope.season
        || known.has(fixture.fixtureId)) {
        throw new Error(`Season fixture discovery returned an invalid or duplicate identity: ${scope.league}:${scope.season}.`);
      }
      known.add(fixture.fixtureId);
      if (dateJst(fixture.kickoffUtc) > todayJst) continue;
      if (!FINAL_STATUSES.has(fixture.status)) { nonFinalCount += 1; continue; }
      finalCount += 1;
      if (Date.parse(fixture.kickoffUtc) + policy.discovery.eligibleAfterKickoffHours * 3600000
        > nowDate.getTime()) { deferredRecentCount += 1; continue; }
      if (!published.has(fixture.fixtureId)) missing.push(fixture);
    }
  }
  missing.sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc)
    || a.providerFixtureId - b.providerFixtureId);
  const deferredDateChanges = missing.filter(fixture => storedDates.has(fixture.fixtureId)
    && storedDates.get(fixture.fixtureId) !== dateJst(fixture.kickoffUtc))
    .map(fixture => ({ fixtureId: fixture.fixtureId,
      storedDateJst: storedDates.get(fixture.fixtureId),
      providerDateJst: dateJst(fixture.kickoffUtc) }));
  const deferredIds = new Set(deferredDateChanges.map(item => item.fixtureId));
  const eligible = missing.filter(fixture => !deferredIds.has(fixture.fixtureId));
  const remaining = client.lastQuota?.dailyRemaining;
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw new Error('API-Football daily remaining quota is unavailable.');
  }
  const capacity = Math.min(policy.limits.maxProviderRequestsPerRun - 11,
    Math.max(0, remaining - policy.limits.dailyRequestReserve));
  const standingsFetches = capacity >= policy.competitionSeasons.length
    ? policy.competitionSeasons.map(scope => ({
      ...scope,
      competitionId: `af:competition:${scope.league}`,
      seasonId: `af:season:${scope.league}:${scope.season}`,
    })) : [];
  const detailBudget = capacity - standingsFetches.length;
  const publishCapacity = Math.max(0, Math.min(dailyBudget.remaining,
    MAX_DAILY_DETAIL_PUBLISHES - dailyBudget.fixtureIds.length));
  const maxDetails = Math.min(policy.limits.maxFinalDetailFixturesPerRun,
    publishCapacity, Math.floor(detailBudget / 5));
  const detailFetches = eligible.slice(0, maxDetails).map(fixture => ({
    ...fixture, recheckStage: 'initial',
    dueAt: new Date(Date.parse(fixture.kickoffUtc)
      + policy.discovery.eligibleAfterKickoffHours * 3600000).toISOString(),
  }));
  return {
    schemaVersion: PLAN_VERSION,
    mode: preview ? 'preview' : 'enabled',
    generatedAt: nowDate.toISOString(),
    discoveryDates: [],
    totalDiscoveredFixtureCount: known.size,
    finalFixtureCount: finalCount,
    alreadyPublishedCount: finalCount - missing.length - deferredRecentCount,
    nonFinalCount,
    deferredRecentCount,
    missingFixtureCount: missing.length,
    missingFixtureIds: missing.map(item => item.fixtureId),
    deferredDateChanges,
    remainingAfterBatch: eligible.length - detailFetches.length,
    detailFetches,
    standingsFetches,
    quota: {
      dailyRemaining: remaining,
      reserve: policy.limits.dailyRequestReserve,
      estimatedProviderRequests: 11 + 5 * detailFetches.length + standingsFetches.length,
      fixturePublishesRemaining: publishCapacity - detailFetches.length,
    },
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((items, arg, index, argv) => {
    if (arg.startsWith('--') && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      items.push([arg.slice(2), argv[index + 1]]);
    }
    return items;
  }, []));
  if (!args.policy || !args.inventory || !args['stored-dates'] || !args.budget || !args.out
    || !['true', 'false'].includes(args.preview)) {
    throw new Error('Use --policy FILE --inventory FILE --stored-dates FILE --budget FILE --out FILE --preview true|false.');
  }
  const plan = await planManualFixtureBackfill({
    policy: JSON.parse(fs.readFileSync(args.policy, 'utf8')),
    inventory: JSON.parse(fs.readFileSync(args.inventory, 'utf8')),
    dateInventory: JSON.parse(fs.readFileSync(args['stored-dates'], 'utf8')),
    dailyBudget: JSON.parse(fs.readFileSync(args.budget, 'utf8')),
    client: createClientFromEnv(process.env), preview: args.preview === 'true',
  });
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    mode: plan.mode, finalFixtureCount: plan.finalFixtureCount,
    alreadyPublishedCount: plan.alreadyPublishedCount,
    missingFixtureCount: plan.missingFixtureCount,
    deferredDateChanges: plan.deferredDateChanges,
    batchFixtureCount: plan.detailFetches.length,
    remainingAfterBatch: plan.remainingAfterBatch,
    standingsCount: plan.standingsFetches.length,
    quota: plan.quota,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
}

module.exports = { planManualFixtureBackfill, publishedFixtureIds, storedFixtureDates };
