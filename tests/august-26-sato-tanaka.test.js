const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

test('Aug 26 overlay preserves Sato high-confidence rating and Tanaka missing discipline inputs', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-26-2.json');
  const sato = fragment.playerMatchStats.find((r) => r.recordId === 'r-sato-valencia-betis-20260825');
  const tanaka = fragment.playerMatchStats.find((r) => r.recordId === 'r-tanaka-forest-leeds-20260825');

  assert.ok(sato);
  assert.equal(sato.values.minutes, 90);
  assert.equal(sato.values.yellowCards, 1);
  assert.equal(sato.values.shots, 4);
  assert.equal(sato.values.shotsOnTarget, 1);
  assert.equal(sato.values.passesCompleted, 18);
  assert.equal(sato.values.passesAttempted, 20);
  assert.equal(sato.jfwRating, 6.07);
  assert.equal(sato.ratingVersion, '1.0');
  assert.equal(sato.ratingConfidence, 'high');
  assert.equal(sato.ratingCoverage, 0.808);
  assert.equal(sato.ratingInputs.duelsWon.state, 'missing');
  assert.equal(sato.priorityUpdate, true);

  assert.ok(tanaka);
  assert.equal(tanaka.values.minutes, 68);
  assert.equal(tanaka.jfwRating, null);
  assert.equal(tanaka.ratingInputs.yellowCards.state, 'missing');
  assert.equal(tanaka.ratingInputs.penaltiesConceded.state, 'missing');
  assert.equal(tanaka.priorityUpdate, true);
});

test('manifest and snapshot both include the Aug 26 second overlay', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');
  const name = 'latest-2026-08-26-2.json';

  assert.equal(manifest.fragments.at(-1), name);
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.satoBetisRatingIs607HighConfidence, true);
  assert.equal(snapshot.validation.tanakaCupRequiredDisciplineRemainsMissing, true);
});
