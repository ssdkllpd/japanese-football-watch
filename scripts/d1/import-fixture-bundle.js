'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { importFixtureBundle } = require('./fixture-bundle-importer');
const { FixtureRepository } = require('./fixture-repository');
const { compareFixtureBundles } = require('./fixture-shadow-compare');
const { stableStringify } = require('./fixed-snapshot');
const { createLocalD1 } = require('./local-d1');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

async function importAndCompare(database, bundle, catalog, correctionDocument) {
  const imported = importFixtureBundle(database, bundle, catalog, correctionDocument);
  const resolved = await new FixtureRepository(createLocalD1(database))
    .resolveFixture(bundle.fixture.id);
  if (!resolved || resolved.source !== 'd1') throw new Error(`Imported fixture did not resolve from D1: ${bundle.fixture.id}`);
  const shadow = compareFixtureBundles(bundle, resolved.bundle);
  return {
    schemaVersion: 'd1-fixture-bundle-import/1',
    fixtureId: bundle.fixture.id,
    imported,
    shadow,
    passed: shadow.equal,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args['--input'] || !args['--catalog'] || !args['--corrections']
    || !args['--database'] || !args['--report']) {
    throw new Error('Usage: node scripts/d1/import-fixture-bundle.js --input FILE --catalog FILE --corrections FILE --database FILE --report FILE');
  }
  const bundle = JSON.parse(fs.readFileSync(args['--input'], 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(args['--catalog'], 'utf8'));
  const correctionDocument = JSON.parse(fs.readFileSync(args['--corrections'], 'utf8'));
  const database = new DatabaseSync(args['--database']);
  try {
    const report = await importAndCompare(database, bundle, catalog, correctionDocument);
    fs.writeFileSync(args['--report'], `${stableStringify(report)}\n`);
    process.stdout.write(`${JSON.stringify({ fixtureId: report.fixtureId, imported: report.imported.imported, passed: report.passed })}\n`);
    if (!report.passed) process.exitCode = 1;
    return report;
  } finally {
    database.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { importAndCompare, main, parseArguments };
