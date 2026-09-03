'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { r2DateIndexKey, r2FixtureKey, validateFixtureBundle } = require('../v2/fixture-contract');

const PLAN_VERSION = 'jfw-d1-admin-ingest-plan/1';
const CORRECTIONS_VERSION = 'd1-fixture-correction-definitions/1';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || !argv[index + 1]) continue;
    values[key] = argv[index + 1];
    index += 1;
  }
  return values;
}

function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function artifactPath(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a relative artifact path.`);
  }
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error(`${label} escapes the manifest directory.`);
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(resolved);
  const realRelation = path.relative(realRoot, real);
  if (realRelation.startsWith('..') || path.isAbsolute(realRelation)) {
    throw new Error(`${label} escapes the manifest directory through a link.`);
  }
  return real;
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createV2AdminPlan(manifest, manifestDirectory, outputDirectory) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.r2Objects)) {
    throw new Error('V2 publish manifest must contain r2Objects.');
  }
  const fixtures = [];
  const corrections = [];
  const fixtureIds = new Set();
  for (const [index, item] of manifest.r2Objects.entries()) {
    if (item?.role !== 'fixture') continue;
    const bundle = readJson(artifactPath(
      manifestDirectory, item.file, `r2Objects[${index}].file`,
    ), `Fixture artifact ${index}`);
    const errors = validateFixtureBundle(bundle);
    if (errors.length || bundle.contractVersion !== '2.1.0') {
      throw new Error(`Fixture artifact ${index} is not a complete 2.1 bundle: ${errors.join('; ')}`);
    }
    const fixtureId = bundle.fixture.id;
    if (item.fixtureId && item.fixtureId !== fixtureId) throw new Error(`Fixture manifest identity differs: ${fixtureId}.`);
    if (item.key !== r2FixtureKey(bundle)) throw new Error(`Fixture manifest R2 key differs: ${fixtureId}.`);
    if (fixtureIds.has(fixtureId)) throw new Error(`Fixture manifest contains duplicate identity: ${fixtureId}.`);
    fixtureIds.add(fixtureId);
    if (Object.keys(bundle.overrides || {}).length || Object.keys(bundle.fieldIssues || {}).length) {
      throw new Error(`Fixture ${fixtureId} requires reviewed Git correction definitions.`);
    }
    const correctionFile = path.join('d1-corrections', `${safeSegment(fixtureId)}.json`);
    corrections.push({ correctionFile, fixtureId });
    fixtures.push({
      fixtureId,
      competitionId: bundle.fixture.competitionId,
      seasonId: bundle.fixture.seasonId,
      reuseStoredCatalog: true,
      correctionsPath: correctionFile,
    });
  }
  fixtures.sort((left, right) => compareText(left.fixtureId, right.fixtureId));

  const dateIndexCoverages = [];
  const fullDateFeed = typeof manifest.date === 'string'
    && manifest.query && !manifest.query.league && !manifest.query.season;
  if (fullDateFeed) {
    const declared = manifest.r2Objects
      .filter(item => item?.role === 'competition_date_index')
      .map(item => {
        const expectedKey = `football/v2/indexes/competition/${item.competitionId}/date-jst/${manifest.date}.json`;
        if (!/^af:competition:\d+$/.test(String(item.competitionId || ''))
          || item.key !== expectedKey) {
          throw new Error('Competition date index key differs from its declared scope.');
        }
        return item.competitionId;
      })
      .sort(compareText);
    if (new Set(declared).size !== declared.length) throw new Error('Competition date indexes contain duplicates.');
    const derived = [...new Set(fixtures.map(item => item.competitionId))].sort(compareText);
    if (JSON.stringify(declared) !== JSON.stringify(derived)) {
      throw new Error('Competition date index scope differs from fixture artifacts.');
    }
    const generic = manifest.r2Objects.filter(item => item?.role === 'date_index');
    if (generic.length !== 1) throw new Error('A full date feed must declare one generic date index.');
    if (generic[0].key !== r2DateIndexKey(manifest.date)) {
      throw new Error('Generic date index key differs from its declared scope.');
    }
    dateIndexCoverages.push({ date: manifest.date, competitionIds: declared });
  }
  fs.mkdirSync(path.join(outputDirectory, 'd1-corrections'), { recursive: true });
  for (const { correctionFile, fixtureId } of corrections) {
    fs.writeFileSync(path.join(outputDirectory, correctionFile), `${JSON.stringify({
      schemaVersion: CORRECTIONS_VERSION, fixtureId, definitions: [],
    }, null, 2)}\n`);
  }
  return {
    schemaVersion: PLAN_VERSION,
    fixtures,
    standings: [],
    dateIndexCoverages,
    expectedTotals: null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['--manifest'] || !args['--output']) {
    throw new Error('Usage: create-v2-admin-plan.js --manifest FILE --output FILE');
  }
  const manifestPath = path.resolve(args['--manifest']);
  const outputPath = path.resolve(args['--output']);
  const outputDirectory = path.dirname(outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const plan = createV2AdminPlan(
    readJson(manifestPath, 'V2 publish manifest'), path.dirname(manifestPath), outputDirectory,
  );
  fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    fixtureCount: plan.fixtures.length, dateCoverageCount: plan.dateIndexCoverages.length,
  })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

module.exports = { createV2AdminPlan, parseArgs, safeSegment };
