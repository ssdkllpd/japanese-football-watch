'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runFixtureShadowPlan } = require('./fixture-shadow-batch');
const { stableStringify } = require('./fixed-snapshot');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args['--plan'] || !args['--report']) {
    throw new Error('Usage: node scripts/d1/compare-fixture-shadow-batch.js --plan PLAN --report REPORT');
  }
  const planPath = path.resolve(args['--plan']);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const report = runFixtureShadowPlan(plan, { baseDirectory: path.dirname(planPath) });
  const serialized = `${stableStringify(report)}\n`;
  fs.writeFileSync(args['--report'], serialized);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { main, parseArguments };
