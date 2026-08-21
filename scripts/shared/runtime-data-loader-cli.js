'use strict';

const path = require('node:path');
const { loadIntegratedSeasonData } = require('./runtime-data-loader');

function valueOf(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

(async () => {
  const root = path.resolve(valueOf('--root', path.join(__dirname, '..', '..')));
  const season = valueOf('--season', '2026-27');
  const data = await loadIntegratedSeasonData(root, season);
  process.stdout.write(JSON.stringify(data));
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
