const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('retained snapshot mirrors current-season backfill manifest', () => {
  const seasons = readJson('seasons.json');
  const manifestPath = `data/${seasons.current}/backfill/index.json`;
  const manifest = readJson(manifestPath);
  const snapshot = readJson('state/latest_snapshot.json');

  assert.equal(snapshot.season, seasons.current);
  assert.equal(snapshot.overlayManifest.path, manifestPath);
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
});
