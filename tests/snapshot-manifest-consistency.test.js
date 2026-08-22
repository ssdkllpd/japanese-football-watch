const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readBuffer = rel => fs.readFileSync(path.join(ROOT, rel));

function gitBlobSha(content) {
  const header = Buffer.from(`blob ${content.length}\0`);
  return crypto.createHash('sha1').update(header).update(content).digest('hex');
}

test('retained snapshot mirrors current-season backfill manifest', () => {
  const seasons = readJson('seasons.json');
  const manifestPath = `data/${seasons.current}/backfill/index.json`;
  const manifest = readJson(manifestPath);
  const snapshot = readJson('state/latest_snapshot.json');

  assert.equal(snapshot.season, seasons.current);
  assert.equal(snapshot.overlayManifest.path, manifestPath);
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
});

test('retained snapshot pins the complete legacy runtime by content blob', () => {
  const snapshot = readJson('state/latest_snapshot.json');
  const mergeIndex = snapshot.runtime.indexOf('backfill-merge.js');
  const loaderIndex = snapshot.runtime.indexOf('backfill-loader.js');
  const runtimeFiles = snapshot.runtime.filter(file => file !== snapshot.base.path).sort();

  assert.ok(mergeIndex >= 0 && mergeIndex < loaderIndex, 'merge core must be retained before its loader');
  assert.deepEqual(Object.keys(snapshot.runtimeBlobs).sort(), runtimeFiles);
  assert.equal(gitBlobSha(readBuffer(snapshot.base.path)), snapshot.base.blobSha);
  assert.equal(gitBlobSha(readBuffer(snapshot.overlayManifest.path)), snapshot.overlayManifest.blobSha);

  for (const [file, expectedSha] of Object.entries(snapshot.runtimeBlobs)) {
    assert.equal(gitBlobSha(readBuffer(file)), expectedSha, `${file} no longer matches the retained runtime`);
  }
});
