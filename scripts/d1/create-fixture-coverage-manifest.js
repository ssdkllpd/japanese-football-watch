'use strict';

const fs = require('node:fs');
const { buildFixtureCoverageManifest } = require('./fixture-coverage');
const { stableStringify } = require('./fixed-snapshot');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args['--input'] || !args['--output']) {
    throw new Error('Usage: node scripts/d1/create-fixture-coverage-manifest.js --input FIXED_SNAPSHOT --output MANIFEST');
  }
  const snapshot = JSON.parse(fs.readFileSync(args['--input'], 'utf8'));
  const manifest = buildFixtureCoverageManifest(snapshot);
  fs.writeFileSync(args['--output'], `${stableStringify(manifest)}\n`);
  process.stdout.write(`${JSON.stringify(manifest.summary)}\n`);
}

if (require.main === module) main();

module.exports = { main, parseArguments };
