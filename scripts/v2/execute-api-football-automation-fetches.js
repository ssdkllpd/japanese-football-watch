'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClientFromEnv } = require('../api-football/client');
const { PLAN_VERSION } = require('./api-football-automation-plan');
const { fetchFixtureEnvelope, writeFixtureEnvelope } = require('./fetch-fixture-vertical-slice');
const { normalizeStandings, responseArray, writeStandings } = require('./fetch-standings');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--') || !argv[index + 1]) continue;
    values[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

async function executeAutomationFetches({ plan, outputRoot, client, now = () => new Date() }) {
  if (plan?.schemaVersion !== PLAN_VERSION || !Array.isArray(plan.detailFetches)
    || !Array.isArray(plan.standingsFetches) || !['preview', 'enabled'].includes(plan.mode)) {
    throw new Error('Executable automation plan is invalid or disabled.');
  }
  const positive = value => Number.isSafeInteger(value) && value > 0;
  if (plan.detailFetches.some(item => !item || !positive(item.providerFixtureId)
    || item.fixtureId !== `af:fixture:${item.providerFixtureId}`)
    || plan.standingsFetches.some(item => !item || !positive(item.league) || !positive(item.season)
      || item.competitionId !== `af:competition:${item.league}`
      || item.seasonId !== `af:season:${item.league}:${item.season}`)
    || new Set(plan.detailFetches.map(item => item.fixtureId)).size !== plan.detailFetches.length
    || new Set(plan.standingsFetches.map(item => item.seasonId)).size !== plan.standingsFetches.length) {
    throw new Error('Executable automation identities are invalid or duplicated.');
  }
  const root = path.resolve(outputRoot);
  const fixtures = [];
  const quarantined = [];
  for (const item of plan.detailFetches) {
    const directory = path.join(root, 'fixtures', String(item.providerFixtureId));
    try {
    const envelope = await fetchFixtureEnvelope(client, item.providerFixtureId);
    const manifest = writeFixtureEnvelope(directory, envelope, {
      finalized: true, fetchedAt: now().toISOString(),
    });
    if (manifest.fixtureId !== item.fixtureId || manifest.ingestionState !== 'finalized') {
      throw new Error(`Fetched fixture is not the planned finalized identity: ${item.fixtureId}.`);
    }
    fixtures.push({ fixtureId: item.fixtureId, directory });
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      quarantined.push({ identity: item.fixtureId, stage: 'fetch', error: error.message });
    }
  }
  const standings = [];
  for (const item of plan.standingsFetches) {
    try {
    const result = await client.get('standings', { league: item.league, season: item.season });
    const fetchedAt = now().toISOString();
    const snapshot = normalizeStandings(responseArray(result), {
      league: item.league, season: item.season, fetchedAt,
    });
    const directory = path.join(root, 'standings', `${item.league}-${item.season}`);
    const manifest = writeStandings(directory, snapshot, {
      query: { league: item.league, season: item.season }, quota: result.quota,
    });
    if (manifest.competitionId !== item.competitionId || manifest.seasonId !== item.seasonId) {
      throw new Error(`Fetched standings scope differs from plan: ${item.competitionId}/${item.seasonId}.`);
    }
    standings.push({ competitionId: item.competitionId, seasonId: item.seasonId, directory });
    } catch (error) { quarantined.push({ identity: `${item.competitionId}/${item.seasonId}`, stage: 'fetch', error: error.message }); }
  }
  return { fixtureCount: fixtures.length, standingsCount: standings.length, fixtures, standings, quarantined };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.plan || !args.out) throw new Error('Use --plan FILE --out DIR.');
  const plan = JSON.parse(fs.readFileSync(path.resolve(args.plan), 'utf8'));
  const summary = await executeAutomationFetches({
    plan, outputRoot: path.resolve(args.out), client: createClientFromEnv(process.env),
  });
  fs.mkdirSync(path.resolve(args.out), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(args.out), 'fetch-report.json'), JSON.stringify(summary, null, 2));
  const fetched = { ...plan, detailFetches: plan.detailFetches.filter(item => summary.fixtures.some(f => f.fixtureId === item.fixtureId)),
    standingsFetches: plan.standingsFetches.filter(item => summary.standings.some(f => f.competitionId === item.competitionId && f.seasonId === item.seasonId)) };
  fs.writeFileSync(path.join(path.resolve(args.out), 'fetched-plan.json'), JSON.stringify(fetched,null,2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
}

module.exports = { executeAutomationFetches, parseArgs };
