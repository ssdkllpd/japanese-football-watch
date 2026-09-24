'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  advanceAutomationState,
  checkpointAutomationDiscovery,
  emptyAutomationState,
  validateState,
} = require('./api-football-automation-plan');

function readJson(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main(argv = process.argv.slice(2)) {
  const args = Object.fromEntries(argv.reduce((rows, value, index) => {
    if (value.startsWith('--') && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      rows.push([value.slice(2), argv[index + 1]]);
    }
    return rows;
  }, []));
  if (!args.plan || !args.out) throw new Error('Use --plan FILE --state FILE --out FILE.');
  const state = validateState(readJson(args.state, emptyAutomationState()));
  const plan = readJson(args.plan, null);
  const next = args.checkpoint === 'true'
    ? checkpointAutomationDiscovery(state, plan)
    : advanceAutomationState(state, plan, args.completedAt || Date.now());
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    fixtureCount: Object.keys(next.fixtures).length,
    standingsCount: Object.keys(next.standings).length,
    lastSuccessfulRunAt: next.lastSuccessfulRunAt,
  })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}

module.exports = { main, readJson };
