'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { stableStringify } = require('./fixed-snapshot');
const { evaluatePhase2Readiness } = require('./phase2-readiness');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (!args['--snapshot'] || !args['--coverage'] || !args['--database']
    || !args['--plan'] || !args['--report']) {
    throw new Error('Usage: node scripts/d1/verify-phase2-readiness.js --snapshot FILE --coverage FILE --database FILE --plan FILE --report FILE');
  }
  const snapshot = JSON.parse(fs.readFileSync(args['--snapshot'], 'utf8'));
  const coverage = JSON.parse(fs.readFileSync(args['--coverage'], 'utf8'));
  const planPath = path.resolve(args['--plan']);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const database = new DatabaseSync(args['--database'], { readOnly: true });
  try {
    const report = await evaluatePhase2Readiness(database, snapshot, coverage, plan, {
      baseDirectory: path.dirname(planPath),
    });
    fs.writeFileSync(args['--report'], `${stableStringify(report)}\n`);
    process.stdout.write(`${JSON.stringify({ gates: report.gates,
      phase2TechnicalGatePassed: report.phase2TechnicalGatePassed,
      productionReady: report.productionReady })}\n`);
    if (!report.phase2TechnicalGatePassed) process.exitCode = 1;
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

module.exports = { main, parseArguments };
