const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

function loadRatingEngine() {
  const context = { window: { addEventListener() {} }, console, setTimeout() {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'jfw-rating.js'), 'utf8'), context);
  return context.window.JFWRating;
}

test('Aug 26 overlay preserves Sato engine-computed high-confidence rating and Tanaka missing discipline inputs', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-26-2.json');
  const sato = fragment.playerMatchStats.find((r) => r.recordId === 'r-sato-valencia-betis-20260825');
  const tanaka = fragment.playerMatchStats.find((r) => r.recordId === 'r-tanaka-forest-leeds-20260825');
  const engine = loadRatingEngine();

  assert.ok(sato);
  assert.equal(sato.values.minutes, 90);
  assert.equal(sato.values.yellowCards, 1);
  assert.equal(sato.values.shots, 4);
  assert.equal(sato.values.shotsOnTarget, 1);
  assert.equal(sato.values.passesCompleted, 18);
  assert.equal(sato.values.passesAttempted, 20);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.compute(sato.ratingInputs, sato.ratingPosition))), {
    jfwRating: sato.jfwRating,
    ratingVersion: sato.ratingVersion,
    ratingPosition: sato.ratingPosition,
    ratingCoverage: sato.ratingCoverage,
    ratingConfidence: sato.ratingConfidence,
    ratingFactors: sato.ratingFactors,
    deltaPerformance: sato.deltaPerformance,
    deltaDiscipline: sato.deltaDiscipline,
    ratingBreakdown: sato.ratingBreakdown,
  });
  assert.equal(sato.jfwRating, 5.88);
  assert.equal(sato.ratingConfidence, 'high');
  assert.equal(sato.ratingCoverage, 0.791);
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
  assert.equal(snapshot.validation.satoBetisRatingIs588HighConfidence, true);
  assert.equal(snapshot.validation.tanakaCupRequiredDisciplineRemainsMissing, true);
});
