const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const readJson = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

function loadRatingEngine() {
  const context = { window: { addEventListener() {} }, console, setTimeout() {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'jfw-rating.js'), 'utf8'), context);
  return context.window.JFWRating;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('Kubo Real Madrid match keeps exhaustive event zeros and explicit missing advanced fields', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-27-2.json');
  const record = fragment.playerMatchStats.find(r => r.recordId === 'r-kubo-madrid-sociedad-20260826');
  assert.ok(record);
  assert.equal(record.values.minutes, 74);
  assert.equal(record.values.goals, 0);
  assert.equal(record.values.assists, 0);
  assert.equal(record.values.shots, 0);
  assert.equal(record.values.shotsOnTarget, 0);
  assert.equal(record.values.keyPasses, 1);
  assert.equal(record.ratingInputs.dribbles.state, 'missing');
  assert.equal(record.ratingInputs.duelsWon.state, 'missing');
  assert.equal(record.ratingInputs.bigChancesMissed.state, 'missing');
  assert.equal(record.priorityUpdate, true);
});

test('Kubo stored rating exactly matches JFW Rating v1.0 engine', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-27-2.json');
  const record = fragment.playerMatchStats[0];
  const computed = plain(loadRatingEngine().compute(record.ratingInputs, record.ratingPosition));
  assert.equal(computed.jfwRating, record.jfwRating);
  assert.equal(computed.ratingCoverage, record.ratingCoverage);
  assert.equal(computed.ratingConfidence, record.ratingConfidence);
  assert.deepEqual(computed.ratingFactors, record.ratingFactors);
  assert.equal(computed.deltaPerformance, record.deltaPerformance);
  assert.equal(computed.deltaDiscipline, record.deltaDiscipline);
  assert.deepEqual(computed.ratingBreakdown, record.ratingBreakdown);
  assert.equal(record.jfwRating, 6.08);
  assert.equal(record.ratingCoverage, 0.812);
  assert.equal(record.ratingConfidence, 'high');
});

test('manifest and retained snapshot include Kubo Madrid overlay', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');
  assert.equal(manifest.fragments.at(-1), 'latest-2026-08-27-2.json');
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.laligaKuboMadridRatingIs608HighConfidence, true);
});
