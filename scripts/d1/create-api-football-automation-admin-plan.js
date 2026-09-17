'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createV2AdminPlan } = require('./create-v2-admin-plan');
const { PLAN_VERSION: AUTOMATION_PLAN_VERSION } = require('../v2/api-football-automation-plan');
const { r2DateIndexKey, r2FixturePointerKey } = require('../v2/fixture-contract');
const {
  standingsLatestKey,
  standingsSnapshotKey,
  validateStandings,
} = require('../v2/fetch-standings');

const ADMIN_PLAN_VERSION = 'jfw-d1-admin-ingest-plan/1';

function readContainedJson(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a relative path.`);
  }
  const base = fs.realpathSync(root);
  const resolved = path.resolve(base, relative);
  const relation = path.relative(base, resolved);
  if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error(`${label} escapes the artifact root.`);
  const real = fs.realpathSync(resolved);
  const realRelation = path.relative(base, real);
  if (realRelation.startsWith('..') || path.isAbsolute(realRelation)) {
    throw new Error(`${label} escapes the artifact root through a link.`);
  }
  try { return JSON.parse(fs.readFileSync(real, 'utf8')); } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function createAutomationAdminPlan(automationPlan, artifactRoot, outputDirectory) {
  if (automationPlan?.schemaVersion !== AUTOMATION_PLAN_VERSION
    || !Array.isArray(automationPlan.detailFetches)
    || !Array.isArray(automationPlan.standingsFetches)) {
    throw new Error('Automation plan is invalid.');
  }
  const fixtures = [];
  const fixtureIds = new Set();
  for (const item of automationPlan.detailFetches) {
    if (!Number.isSafeInteger(item?.providerFixtureId) || item.providerFixtureId <= 0) {
      throw new Error('Automation fixture provider identity is invalid.');
    }
    const relative = path.join('fixtures', String(item.providerFixtureId), 'manifest.json');
    const manifest = readContainedJson(artifactRoot, relative, `Fixture ${item.fixtureId} manifest`);
    const manifestDirectory = path.dirname(path.resolve(artifactRoot, relative));
    const derived = createV2AdminPlan(manifest, manifestDirectory, outputDirectory);
    if (derived.fixtures.length !== 1) throw new Error(`Fixture ${item.fixtureId} manifest must contain one fixture.`);
    const fixture = derived.fixtures[0];
    if (fixture.fixtureId !== item.fixtureId
      || fixture.competitionId !== item.competitionId
      || fixture.seasonId !== item.seasonId) {
      throw new Error(`Fixture ${item.fixtureId} artifact scope differs from the automation plan.`);
    }
    const bundle = readContainedJson(artifactRoot,
      path.join('fixtures', String(item.providerFixtureId), 'fixture.json'),
      `Fixture ${item.fixtureId} artifact`);
    const pointer = readContainedJson(artifactRoot,
      path.join('fixtures', String(item.providerFixtureId), 'fixture-pointer.json'),
      `Fixture ${item.fixtureId} pointer`);
    const dateIndex = readContainedJson(artifactRoot,
      path.join('fixtures', String(item.providerFixtureId), 'date-index.json'),
      `Fixture ${item.fixtureId} date index`);
    const objects = new Map((manifest.r2Objects || []).map(object => [object?.role, object]));
    const fixtureObject = objects.get('fixture');
    const pointerObject = objects.get('fixture_pointer');
    const dateObject = objects.get('date_index');
    if (manifest.r2Objects.length !== 3 || objects.size !== 3
      || fixtureObject?.file !== 'fixture.json'
      || pointerObject?.file !== 'fixture-pointer.json'
      || pointerObject?.key !== r2FixturePointerKey(item.fixtureId)
      || dateObject?.file !== 'date-index.json'
      || dateObject?.key !== r2DateIndexKey(bundle.fixture.dateJst)
      || dateObject?.merge !== 'date_index'
      || dateObject?.mergeScope !== 'generic'
      || dateObject?.mergeMode !== 'upsert') {
      throw new Error(`Fixture ${item.fixtureId} publish manifest is invalid.`);
    }
    if (pointer.fixtureId !== item.fixtureId || pointer.key !== fixtureObject.key
      || dateIndex.date !== bundle.fixture.dateJst
      || !Array.isArray(dateIndex.fixtures) || dateIndex.fixtures.length !== 1
      || dateIndex.fixtures[0]?.fixtureId !== item.fixtureId) {
      throw new Error(`Fixture ${item.fixtureId} pointer or date index is invalid.`);
    }
    if (fixtureIds.has(fixture.fixtureId)) throw new Error(`Automation artifacts duplicate ${fixture.fixtureId}.`);
    fixtureIds.add(fixture.fixtureId);
    fixtures.push(fixture);
  }

  const standings = [];
  const standingsScopes = new Set();
  for (const item of automationPlan.standingsFetches) {
    if (!Number.isSafeInteger(item?.league) || !Number.isSafeInteger(item?.season)) {
      throw new Error('Automation standings provider scope is invalid.');
    }
    const base = path.join('standings', `${item.league}-${item.season}`);
    const manifest = readContainedJson(artifactRoot, path.join(base, 'manifest.json'),
      `Standings ${item.competitionId}/${item.seasonId} manifest`);
    const snapshot = readContainedJson(artifactRoot, path.join(base, 'standings.json'),
      `Standings ${item.competitionId}/${item.seasonId} artifact`);
    const errors = validateStandings(snapshot);
    if (errors.length) throw new Error(`Standings artifact is invalid: ${errors.join('; ')}`);
    if (manifest.competitionId !== item.competitionId || manifest.seasonId !== item.seasonId
      || snapshot.competition?.id !== item.competitionId || snapshot.season?.id !== item.seasonId) {
      throw new Error(`Standings ${item.competitionId}/${item.seasonId} artifact scope differs from the automation plan.`);
    }
    const expectedObjects = [
      ['standings_snapshot', standingsSnapshotKey(item.competitionId, item.seasonId, snapshot.generatedAt)],
      ['standings_latest', standingsLatestKey(item.competitionId, item.seasonId)],
    ];
    if (!Array.isArray(manifest.r2Objects) || manifest.r2Objects.length !== expectedObjects.length) {
      throw new Error(`Standings ${item.competitionId}/${item.seasonId} publish manifest is incomplete.`);
    }
    for (const [role, key] of expectedObjects) {
      const matches = manifest.r2Objects.filter(object => object?.role === role
        && object.key === key && object.file === 'standings.json');
      if (matches.length !== 1) {
        throw new Error(`Standings ${item.competitionId}/${item.seasonId} ${role} object is invalid.`);
      }
    }
    const scope = `${item.competitionId}/${item.seasonId}`;
    if (standingsScopes.has(scope)) throw new Error(`Automation artifacts duplicate standings ${scope}.`);
    standingsScopes.add(scope);
    standings.push({ competitionId: item.competitionId, seasonId: item.seasonId });
  }

  fixtures.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
  standings.sort((left, right) => left.competitionId.localeCompare(right.competitionId)
    || left.seasonId.localeCompare(right.seasonId));
  return {
    schemaVersion: ADMIN_PLAN_VERSION,
    fixtures,
    standings,
    dateIndexCoverages: [],
    expectedTotals: null,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--') || !argv[index + 1]) continue;
    values[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.plan || !args.artifacts || !args.output) {
    throw new Error('Use --plan FILE --artifacts DIR --output FILE.');
  }
  const planPath = path.resolve(args.plan);
  const outputPath = path.resolve(args.output);
  const outputDirectory = path.dirname(outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const plan = createAutomationAdminPlan(
    JSON.parse(fs.readFileSync(planPath, 'utf8')),
    path.resolve(args.artifacts),
    outputDirectory,
  );
  fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    fixtureCount: plan.fixtures.length, standingsCount: plan.standings.length,
  })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}

module.exports = { createAutomationAdminPlan, parseArgs, readContainedJson };
