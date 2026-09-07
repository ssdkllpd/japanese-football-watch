'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('./import-fixed-snapshot');
const { runCanonicalFixturePlan } = require('./canonical-fixture-batch');
const { stableStringify } = require('./fixed-snapshot');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args['--plan'] || !args['--database'] || !args['--report']) {
    throw new Error('Usage: node scripts/d1/import-canonical-fixture-batch.js --plan PLAN --database FILE --report REPORT');
  }
  const root = path.join(__dirname, '..', '..');
  const planPath = path.resolve(args['--plan']);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const database = new DatabaseSync(args['--database']);
  try {
    ensureSchema(database, root);
    const report = await runCanonicalFixturePlan(database, plan, { baseDirectory: path.dirname(planPath) });
    fs.writeFileSync(args['--report'], `${stableStringify(report)}\n`);
    process.stdout.write(`${JSON.stringify(report.summary)}\n`);
    if (!report.passed) process.exitCode = 1;
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

module.exports = { main, parseArguments };
