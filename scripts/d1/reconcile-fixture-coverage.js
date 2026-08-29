'use strict';

const fs = require('node:fs');
const { reconcileCanonicalFixtureImports } = require('./fixture-coverage');
const { stableStringify } = require('./fixed-snapshot');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args['--coverage'] || !args['--imports'] || !args['--output']) {
    throw new Error('Usage: node scripts/d1/reconcile-fixture-coverage.js --coverage FILE --imports FILE --output FILE');
  }
  const coverage = JSON.parse(fs.readFileSync(args['--coverage'], 'utf8'));
  const imports = JSON.parse(fs.readFileSync(args['--imports'], 'utf8'));
  const reconciled = reconcileCanonicalFixtureImports(coverage, imports);
  fs.writeFileSync(args['--output'], `${stableStringify(reconciled)}\n`);
  process.stdout.write(`${JSON.stringify(reconciled.summary)}\n`);
}

if (require.main === module) main();

module.exports = { main, parseArguments };
