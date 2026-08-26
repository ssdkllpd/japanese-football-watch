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

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Aug 26 v2 overlay retains four verified Aug 25 appearances', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-26-3.json');
  const byPlayer = Object.fromEntries(fragment.playerMatchStats.map((r) => [r.player, r]));

  assert.equal(byPlayer['田中碧'].jfwRating, 5.89);
  assert.equal(byPlayer['田中碧'].ratingCoverage, 0.563);
  assert.equal(byPlayer['田中碧'].ratingConfidence, 'medium');
  assert.equal(byPlayer['田中碧'].ratingInputs.keyPasses.value, 1);
  assert.equal(byPlayer['田中碧'].ratingInputs.passesAttempted.state, 'missing');

  assert.equal(byPlayer['坂元達裕'].values.minutes, 90);
  assert.equal(byPlayer['坂元達裕'].values.shots, 1);
  assert.equal(byPlayer['坂元達裕'].values.shotsOnTarget, 0);
  assert.equal(byPlayer['坂元達裕'].values.keyPasses, 1);
  assert.equal(byPlayer['坂元達裕'].jfwRating, 6.12);
  assert.equal(byPlayer['坂元達裕'].ratingCoverage, 0.764);
  assert.equal(byPlayer['坂元達裕'].ratingConfidence, 'high');

  assert.equal(byPlayer['旗手怜央'].values.minutes, 57);
  assert.equal(byPlayer['旗手怜央'].jfwRating, 6.0);
  assert.equal(byPlayer['旗手怜央'].ratingConfidence, 'medium');

  assert.equal(byPlayer['佐藤龍之介'].round, '第1節');
  assert.equal(byPlayer['佐藤龍之介'].values.keyPasses, 1);
  assert.equal(byPlayer['佐藤龍之介'].values.passesCompleted, 18);
  assert.equal(byPlayer['佐藤龍之介'].values.passesAttempted, 20);
  assert.equal(byPlayer['佐藤龍之介'].values.tackles, 1);
  assert.equal(byPlayer['佐藤龍之介'].ratingConflicts[0].field, 'keyPasses');
  assert.equal(byPlayer['佐藤龍之介'].jfwRating, 5.99);
  assert.equal(byPlayer['佐藤龍之介'].ratingCoverage, 0.791);
  assert.equal(byPlayer['佐藤龍之介'].ratingConfidence, 'high');
});

test('stored ratings exactly match JFW Rating v1.0 engine output', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-26-3.json');
  const engine = loadRatingEngine();

  for (const record of fragment.playerMatchStats) {
    const computed = plain(engine.compute(record.ratingInputs, record.ratingPosition));
    assert.equal(computed.jfwRating, record.jfwRating, `${record.player} rating`);
    assert.equal(computed.ratingCoverage, record.ratingCoverage, `${record.player} coverage`);
    assert.equal(computed.ratingConfidence, record.ratingConfidence, `${record.player} confidence`);
    assert.deepEqual(computed.ratingFactors, record.ratingFactors, `${record.player} factors`);
    assert.equal(computed.deltaPerformance, record.deltaPerformance, `${record.player} performance`);
    assert.equal(computed.deltaDiscipline, record.deltaDiscipline, `${record.player} discipline`);
    assert.deepEqual(computed.ratingBreakdown, record.ratingBreakdown, `${record.player} breakdown`);
  }
});

test('manifest and snapshot append v2 overlay without losing prior validation', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');
  assert.equal(manifest.fragments.at(-1), 'latest-2026-08-26-3.json');
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.morishitaCarabaoAssistPreserved, true);
  assert.equal(snapshot.validation.aug26CarabaoMatchProvenancePresent, true);
  assert.equal(snapshot.validation.sakamotoPlymouthCupRatingIs612High, true);
  assert.equal(snapshot.validation.satoBetisRatingIs599HighConfidence, true);
});
