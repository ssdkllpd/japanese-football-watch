'use strict';

const fs = require('node:fs');
const { compareFixtureBundles } = require('./fixture-shadow-compare');
const { stableStringify } = require('./fixed-snapshot');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args['--json'] || !args['--d1']) {
    throw new Error('Usage: node scripts/d1/compare-fixture-shadow.js --json JSON_BUNDLE --d1 D1_BUNDLE [--report REPORT]');
  }
  const jsonBundle = JSON.parse(fs.readFileSync(args['--json'], 'utf8'));
  const d1Bundle = JSON.parse(fs.readFileSync(args['--d1'], 'utf8'));
  const report = compareFixtureBundles(jsonBundle, d1Bundle);
  const serialized = `${stableStringify(report)}\n`;
  if (args['--report']) fs.writeFileSync(args['--report'], serialized);
  process.stdout.write(serialized);
  if (!report.equal) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main, parseArguments };
