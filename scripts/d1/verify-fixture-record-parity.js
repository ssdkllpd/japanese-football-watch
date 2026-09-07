'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('./fixed-snapshot');
const { verifyFixtureRecordParity } = require('./fixture-record-parity');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args['--snapshot'] || !args['--coverage'] || !args['--database'] || !args['--output']) {
    throw new Error('Usage: node scripts/d1/verify-fixture-record-parity.js --snapshot FILE --coverage FILE --database FILE --output FILE');
  }
  const snapshot = JSON.parse(fs.readFileSync(args['--snapshot'], 'utf8'));
  const coverage = JSON.parse(fs.readFileSync(args['--coverage'], 'utf8'));
  const database = new DatabaseSync(args['--database'], { readOnly: true });
  try {
    const verified = verifyFixtureRecordParity(database, snapshot, coverage);
    fs.writeFileSync(args['--output'], `${stableStringify(verified)}\n`);
    process.stdout.write(`${JSON.stringify({
      factParityPassedRecords: verified.summary.factParityPassedRecords,
      factParityPartialRecords: verified.summary.factParityPartialRecords,
      factParityFailedRecords: verified.summary.factParityFailedRecords,
      factParityGatePassed: verified.summary.factParityGatePassed,
      productionReady: verified.productionReady,
    })}\n`);
    if (!verified.summary.factParityGatePassed) process.exitCode = 1;
    return verified;
  } finally {
    database.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArguments };
