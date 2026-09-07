'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { artifactSha256, buildFixedSnapshot, currentSnapshotInputs, stableStringify } = require('./fixed-snapshot');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args['--output'] || !args['--created-at'] || !args['--starts-on'] || !args['--ends-on']) {
    throw new Error('Usage: node scripts/d1/create-current-fixed-snapshot.js --output FILE --created-at UTC_ISO --starts-on YYYY-MM-DD --ends-on YYYY-MM-DD');
  }
  const root = path.join(__dirname, '..', '..');
  const inputs = currentSnapshotInputs(root, { season: args['--season'] });
  const snapshot = buildFixedSnapshot({
    ...inputs,
    createdAt: args['--created-at'],
    season: {
      id: inputs.seasonId,
      label: inputs.seasonId,
      startsOn: args['--starts-on'],
      endsOn: args['--ends-on'],
    },
  });
  fs.writeFileSync(args['--output'], stableStringify(snapshot));
  process.stdout.write(`${artifactSha256(snapshot)}\n`);
}

if (require.main === module) main();

module.exports = { main, parseArguments };
