'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PLAN_VERSION } = require('./api-football-automation-plan');

const VERSION = 'jfw-manual-backfill-checkpoint/1';

function checkpointFromArtifacts(plan, root) {
  if (plan?.schemaVersion !== PLAN_VERSION || !Array.isArray(plan.detailFetches)
    || plan.detailFetches.length === 0 || plan.detailFetches.length > 20) {
    throw new Error('Manual backfill batch is invalid.');
  }
  const fixtures = plan.detailFetches.map(item => {
    const id = item.providerFixtureId;
    if (!Number.isSafeInteger(id) || item.fixtureId !== `af:fixture:${id}`) {
      throw new Error('Manual backfill fixture identity is invalid.');
    }
    const artifact = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', String(id), 'fixture.json'), 'utf8'));
    if (artifact.fixture?.id !== item.fixtureId
      || artifact.fixture.competitionId !== item.competitionId
      || artifact.fixture.seasonId !== item.seasonId
      || !/^\d{4}-\d{2}-\d{2}$/.test(artifact.fixture.dateJst)) {
      throw new Error(`Manual backfill checkpoint artifact differs: ${item.fixtureId}.`);
    }
    return { fixtureId: item.fixtureId, dateJst: artifact.fixture.dateJst };
  });
  if (new Set(fixtures.map(item => item.fixtureId)).size !== fixtures.length) {
    throw new Error('Manual backfill checkpoint duplicates a fixture.');
  }
  return { schemaVersion: VERSION, status: 'pending', fixtures };
}

function recoveryDates(checkpoint, inventory) {
  if (checkpoint?.schemaVersion !== VERSION
    || !['pending', 'complete'].includes(checkpoint.status)
    || !Array.isArray(checkpoint.fixtures) || checkpoint.fixtures.length > 20) {
    throw new Error('Manual backfill checkpoint is invalid.');
  }
  if (checkpoint.status === 'complete') return [];
  const { publishedFixtureIds } = require('./plan-manual-fixture-backfill');
  const published = publishedFixtureIds(inventory);
  const dates = new Map();
  const seen = new Set();
  for (const item of checkpoint.fixtures) {
    if (!/^af:fixture:\d+$/.test(item?.fixtureId)
      || !/^\d{4}-\d{2}-\d{2}$/.test(item?.dateJst)
      || new Date(`${item.dateJst}T00:00:00Z`).toISOString().slice(0, 10) !== item.dateJst
      || seen.has(item.fixtureId)) {
      throw new Error('Manual backfill checkpoint has invalid fixture metadata.');
    }
    seen.add(item.fixtureId);
    if (!published.has(item.fixtureId)) continue;
    if (!dates.has(item.dateJst)) dates.set(item.dateJst, []);
    dates.get(item.dateJst).push(item.fixtureId);
  }
  return [...dates].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, fixtureIds]) => ({ date, fixtureIds: fixtureIds.sort() }));
}

function main() {
  const [mode, a, b, c] = process.argv.slice(2);
  let result;
  if (mode === 'create') {
    result = checkpointFromArtifacts(JSON.parse(fs.readFileSync(a, 'utf8')), b);
  } else if (mode === 'recover') {
    result = recoveryDates(JSON.parse(fs.readFileSync(a, 'utf8')),
      JSON.parse(fs.readFileSync(b, 'utf8')));
  } else throw new Error('Use create PLAN ARTIFACTS OUT or recover CHECKPOINT INVENTORY OUT.');
  const output = c;
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ mode, count: Array.isArray(result) ? result.length : result.fixtures.length })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}

module.exports = { VERSION, checkpointFromArtifacts, recoveryDates };
