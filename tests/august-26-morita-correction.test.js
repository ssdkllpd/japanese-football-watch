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

test('Morita Stoke-Hull record is corrected to a 59th-minute substitute appearance', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-26-4.json');
  const record = fragment.playerMatchStats.find((r) => r.player === '守田英正');

  assert.ok(record);
  assert.equal(record.appearance, 'sub_59');
  assert.equal(record.start, false);
  assert.equal(record.bench, true);
  assert.equal(record.values.minutes, 31);
  assert.equal(record.values.goals, 0);
  assert.equal(record.values.assists, 0);
  assert.equal(record.values.shots, 0);
  assert.equal(record.values.shotsOnTarget, 0);
  assert.equal(record.values.keyPasses, 1);
  assert.equal(record.values.yellowCards, 0);
  assert.equal(record.values.secondYellowRed, 0);
  assert.equal(record.values.straightRed, 0);
  assert.equal(record.values.penaltiesConceded, 0);
  assert.equal(record.values.ownGoals, 0);
  assert.equal(record.ratingInputs.minutes.value, 31);
  assert.equal(record.ratingInputs.keyPasses.value, 1);
  assert.equal(record.ratingInputs.passesAttempted.state, 'missing');
  assert.equal(record.ratingInputs.duelsTotal.state, 'missing');
  assert.equal(record.ratingConflicts.some((c) => c.field === 'appearance'), true);
  assert.equal(record.ratingConflicts.some((c) => c.field === 'minutes'), true);
});

test('Morita persisted ratingInputs reproduce stored JFW Rating v1.0', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-26-4.json');
  const record = fragment.playerMatchStats.find((r) => r.player === '守田英正');
  const engine = loadRatingEngine();
  const computed = JSON.parse(JSON.stringify(engine.compute(record.ratingInputs, record.ratingPosition)));

  assert.equal(computed.jfwRating, 6.07);
  assert.equal(computed.ratingCoverage, 0.563);
  assert.equal(computed.ratingConfidence, 'medium');
  assert.equal(record.jfwRating, computed.jfwRating);
  assert.equal(record.ratingCoverage, computed.ratingCoverage);
  assert.equal(record.ratingConfidence, computed.ratingConfidence);
});

test('Morita correction is the latest append-only overlay and snapshot agrees', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');

  assert.equal(manifest.fragments.at(-1), 'latest-2026-08-26-4.json');
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.moritaCarabaoSub59CorrectionApplied, true);
  assert.equal(snapshot.validation.moritaCarabaoRatingIs607Medium, true);
  assert.equal(snapshot.validation.moritaCarabaoStartAnd59MinuteSubstitutionPreserved, undefined);
});
