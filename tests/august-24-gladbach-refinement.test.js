const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const fragmentName = 'latest-2026-08-24-5.json';
const fragment = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2026-27/backfill', fragmentName), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/2026-27/backfill/index.json'), 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/latest_snapshot.json'), 'utf8'));

function record(player) {
  return fragment.playerMatchStats.find(r => r.player === player);
}

test('Gladbach cup refinement preserves verified Japanese appearance facts without premature ratings', () => {
  const hashioka = record('橋岡大樹');
  const itakura = record('板倉滉');
  const machino = record('町野修斗');
  const uno = record('宇野禅斗');

  assert.ok(hashioka && itakura && machino && uno);
  assert.equal(hashioka.values.minutes, 90);
  assert.equal(hashioka.values.goals, 1);
  assert.equal(hashioka.values.gaOnPitch, 0);
  assert.equal(itakura.values.minutes, 33);
  assert.equal(itakura.values.gaOnPitch, 0);
  assert.equal(machino.values.minutes, 20);
  assert.equal(uno.appearance, 'absent_not_in_squad');
  assert.equal(uno.values.minutes, 0);

  for (const r of [hashioka, itakura, machino]) {
    assert.equal(r.jfwRating, null);
    assert.equal(r.ratingVersion, '1.0');
    assert.equal(r.ratingInputs.yellowCards.state, 'missing');
    assert.equal(r.priorityUpdate, true);
  }
  assert.equal(uno.jfwRating, null);
  assert.equal(uno.priorityUpdate, false);
});

test('manifest and retained snapshot preserve the Gladbach refinement in append-only order', () => {
  const manifestIndex = manifest.fragments.indexOf(fragmentName);
  const snapshotIndex = snapshot.overlayManifest.orderedFragments.indexOf(fragmentName);
  assert.ok(manifestIndex >= 0);
  assert.equal(snapshotIndex, manifestIndex);
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.snapshotManifestMatchesCurrentManifest, true);
  assert.equal(snapshot.validation.bundesligaGladbachCupJapaneseAppearancesRefined, true);
});
