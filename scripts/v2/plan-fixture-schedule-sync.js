'use strict';

const fs = require('node:fs');
const { createClientFromEnv } = require('../api-football/client');
const { canonicalFixture } = require('./api-football-automation-plan');
const policy = require('../../config/api-football-automation.json');

const MUTABLE = new Set(['NS', 'TBD', 'PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP', 'INT']);

function inventoryRows(json) {
  if (!Array.isArray(json) || json.length !== 1 || json[0]?.success === false
    || !Array.isArray(json[0]?.results)) throw new Error('D1 schedule inventory failed.');
  const rows = json[0].results;
  if (rows.length === 0 || rows.some(row => row.total !== rows.length)) {
    throw new Error('D1 schedule inventory is incomplete.');
  }
  const ids = new Set();
  for (const row of rows) {
    if (!/^af:fixture:\d+$/.test(row.fixture_id) || ids.has(row.fixture_id)
      || !/^af:competition:\d+$/.test(row.competition_id)
      || !/^af:season:\d+:\d+$/.test(row.season_id)
      || !Number.isFinite(Date.parse(row.kickoff_utc))) {
      throw new Error('D1 schedule inventory has an invalid identity.');
    }
    ids.add(row.fixture_id);
  }
  return rows;
}

async function planScheduleSync({ client, inventory }) {
  const scopes = new Set(policy.competitionSeasons.map(item => `af:season:${item.league}:${item.season}`));
  const stored = inventoryRows(inventory).filter(row => scopes.has(row.season_id));
  if (!stored.length) throw new Error('D1 schedule inventory has no configured fixtures.');
  const byId = new Map(stored.map(row => [row.fixture_id, row]));
  const seen = new Set();
  const changes = [];
  const held = [];
  let responseQuota = await client.refreshDailyQuota();
  if (!Number.isSafeInteger(responseQuota?.dailyRemaining)
    || responseQuota.dailyRemaining < 111) throw new Error('Provider quota cannot cover season discovery and reserve.');
  for (const scope of policy.competitionSeasons) {
    const result = await client.get('fixtures', {
      league: scope.league, season: scope.season, timezone: policy.timeZone,
    });
    responseQuota = result.quota || responseQuota;
    const response = result.data?.response;
    if (!Array.isArray(response) || response.length === 0
      || Number(result.data?.paging?.total ?? 1) !== 1) {
      throw new Error(`Season ${scope.league}:${scope.season} is incomplete.`);
    }
    for (const raw of response) {
      const fixture = canonicalFixture(raw);
      if (!fixture || fixture.league !== scope.league || fixture.season !== scope.season
        || seen.has(fixture.fixtureId)) throw new Error('Provider schedule identity is invalid or duplicated.');
      seen.add(fixture.fixtureId);
      const old = byId.get(fixture.fixtureId);
      if (!old) { held.push({ fixtureId: fixture.fixtureId, reason: 'new_fixture_requires_catalog' }); continue; }
      if (old.competition_id !== fixture.competitionId || old.season_id !== fixture.seasonId) {
        throw new Error(`Provider changed fixture scope: ${fixture.fixtureId}.`);
      }
      // Providers can retain a placeholder kickoff while a postponed date is unknown.
      // Keep the last confirmed kickoff internally, but render PST/TBD as undetermined.
      if (fixture.status === 'PST' || fixture.status === 'TBD') {
        if (Date.parse(old.kickoff_utc) !== Date.parse(fixture.kickoffUtc)) {
          held.push({ fixtureId: fixture.fixtureId, reason: 'postponed_kickoff_unconfirmed' });
        }
        fixture.kickoffUtc = old.kickoff_utc;
      }
      const oldKickoff = Date.parse(old.kickoff_utc);
      const different = oldKickoff !== Date.parse(fixture.kickoffUtc)
        || old.status_short !== fixture.status;
      if (!different) continue;
      if (old.published_revision !== null && old.published_revision !== undefined) {
        held.push({ fixtureId: fixture.fixtureId, reason: 'published_detail_requires_reconciliation',
          storedKickoffUtc: old.kickoff_utc, providerKickoffUtc: fixture.kickoffUtc,
          storedStatus: old.status_short, providerStatus: fixture.status });
      } else if (!MUTABLE.has(old.status_short) || !MUTABLE.has(fixture.status)) {
        held.push({ fixtureId: fixture.fixtureId, reason: 'non_schedule_status' });
      } else {
        changes.push({ schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_schedule_update',
          fixtureId: fixture.fixtureId, competitionId: fixture.competitionId,
          seasonId: fixture.seasonId, oldKickoffUtc: old.kickoff_utc,
          oldStatus: old.status_short, newKickoffUtc: fixture.kickoffUtc,
          newStatus: fixture.status });
      }
    }
  }
  const missing = stored.filter(row => !seen.has(row.fixture_id));
  held.push(...missing.map(row => ({ fixtureId: row.fixture_id,
    reason: 'provider_fixture_missing', storedKickoffUtc: row.kickoff_utc, storedStatus: row.status_short })));
  if (!Number.isSafeInteger(responseQuota?.dailyRemaining)
    || responseQuota.dailyRemaining < policy.limits.dailyRequestReserve) {
    throw new Error('Provider quota fell below the reserved balance.');
  }
  const now = Date.now();
  function urgency(item) {
    const dates = [Date.parse(item.oldKickoffUtc), Date.parse(item.newKickoffUtc)];
    const future = dates.filter(date => date >= now);
    return future.length ? Math.min(...future) : Math.max(...dates);
  }
  changes.sort((a, b) => urgency(a) - urgency(b) || a.fixtureId.localeCompare(b.fixtureId));
  return { schemaVersion: 'jfw-fixture-schedule-plan/1', generatedAt: new Date().toISOString(),
    scanned: seen.size, changes, held, executable: true, batchSize: Math.min(20, changes.length),
    remainingAfterBatch: Math.max(0, changes.length - 20),
    dailyRemaining: responseQuota.dailyRemaining };
}

if (require.main === module) {
  const [inventoryFile, outputFile] = process.argv.slice(2);
  if (!inventoryFile || !outputFile) throw new Error('Use INVENTORY.json PLAN.json.');
  planScheduleSync({ client: createClientFromEnv(process.env),
    inventory: JSON.parse(fs.readFileSync(inventoryFile, 'utf8')) })
    .then(result => {
      fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ scanned: result.scanned, changes: result.changes.length,
        held: result.held.length, executable: result.executable,
        dailyRemaining: result.dailyRemaining })}\n`);
    }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { inventoryRows, planScheduleSync };
