'use strict';

const fs = require('node:fs');

function load(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function mergeDateIndex(current, incoming, options) {
  const { mergeDateIndexes } = await import('../../shared/date-index-contract.mjs');
  return mergeDateIndexes(current, incoming, options);
}

if (require.main === module) {
  const [currentPath, incomingPath, outputPath, scope, mode, replaceCompetitionId] = process.argv.slice(2);
  if (!incomingPath || !outputPath || !scope || !mode) {
    console.error('Usage: node merge-date-index.js <current-or-dash> <incoming> <output> <generic|competition-id> <upsert|replace|replace-scope> [replace-competition-id]');
    process.exit(2);
  }
  Promise.resolve().then(async () => {
    const current = currentPath === '-' ? null : load(currentPath);
    const incoming = load(incomingPath);
    const expectedCompetitionId = scope === 'generic' ? null : scope;
    const merged = await mergeDateIndex(current, incoming, {
      expectedCompetitionId,
      mode,
      replaceCompetitionId: replaceCompetitionId === '-' ? undefined : replaceCompetitionId,
    });
    fs.writeFileSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  }).catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { mergeDateIndex };
