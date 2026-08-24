const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('Koki Machida current Hoffenheim membership is registered without inventing match stats', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-24-9.json');
  const snapshot = readJson('state/latest_snapshot.json');

  assert.ok(manifest.fragments.includes('latest-2026-08-24-9.json'));
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.bundesligaHoffenheimMachidaMembershipLoadsThroughPlayerUpdates, true);

  const machida = fragment.playerUpdates.find(player => player.name === '町田浩樹');
  assert.ok(machida);
  assert.equal(machida.club, 'ホッフェンハイム');
  assert.equal(machida.league, 'ブンデスリーガ');
  assert.equal(machida.pos, 'DF');
  assert.equal(machida.squadNumber, 28);
  assert.equal(machida.priorityUpdate, true);
  assert.ok(machida.priorityFields.includes('apiFootballPlayerId'));
  assert.equal(fragment.playerMatchStats, undefined);
});
