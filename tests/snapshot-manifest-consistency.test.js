const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const gitBlobSha = rel => {
  const body = fs.readFileSync(path.join(ROOT, rel));
  const header = Buffer.from(`blob ${body.length}\0`);
  return crypto.createHash('sha1').update(Buffer.concat([header, body])).digest('hex');
};

test('retained snapshot mirrors current-season backfill manifest and runtime dependencies', () => {
  const seasons = readJson('seasons.json');
  const manifestPath = `data/${seasons.current}/backfill/index.json`;
  const manifest = readJson(manifestPath);
  const snapshot = readJson('state/latest_snapshot.json');

  assert.equal(snapshot.season, seasons.current);
  assert.equal(snapshot.overlayManifest.path, manifestPath);
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.runtimeBlobs['backfill-loader.js'], gitBlobSha('backfill-loader.js'));
  assert.equal(snapshot.runtimeBlobs['config/player-registry.json'], gitBlobSha('config/player-registry.json'));
});
