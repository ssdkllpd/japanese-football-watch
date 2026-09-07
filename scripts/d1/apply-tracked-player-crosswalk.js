'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('./fixed-snapshot');
const { applyTrackedPlayerCrosswalkPlan } = require('./tracked-player-crosswalk-executor');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args['--snapshot'] || !args['--coverage'] || !args['--database']
    || !args['--plan'] || !args['--report']) {
    throw new Error('Usage: node scripts/d1/apply-tracked-player-crosswalk.js --snapshot FILE --coverage FILE --database FILE --plan FILE --report FILE');
  }
  const snapshot = JSON.parse(fs.readFileSync(args['--snapshot'], 'utf8'));
  const coverage = JSON.parse(fs.readFileSync(args['--coverage'], 'utf8'));
  const plan = JSON.parse(fs.readFileSync(args['--plan'], 'utf8'));
  const database = new DatabaseSync(args['--database']);
  try {
    const report = applyTrackedPlayerCrosswalkPlan(database, snapshot, coverage, plan);
    fs.writeFileSync(args['--report'], `${stableStringify(report)}\n`);
    process.stdout.write(`${JSON.stringify(report.summary)}\n`);
    if (report.summary.failedPlayers || report.summary.stalePlayers) process.exitCode = 1;
    return report;
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
