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

test('Aug 26 consolidated overlay preserves all four verified Aug 25 appearances', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-26-2.json');
  const byPlayer = Object.fromEntries(fragment.playerMatchStats.map((r) => [r.player, r]));

  assert.equal(byPlayer['田中碧'].jfwRating, 5.89);
  assert.equal(byPlayer['田中碧'].ratingCoverage, 0.563);
  assert.equal(byPlayer['田中碧'].ratingConfidence, 'medium');
  assert.equal(byPlayer['田中碧'].ratingInputs.keyPasses.value, 1);
  assert.equal(byPlayer['田中碧'].ratingInputs.passesAttempted.state, 'missing');

  assert.equal(byPlayer['坂元達裕'].values.minutes, 90);
  assert.equal(byPlayer['坂元達裕'].jfwRating, 6.0);
  assert.equal(byPlayer['坂元達裕'].ratingConfidence, 'medium');

  assert.equal(byPlayer['旗手怜央'].values.minutes, 57);
  assert.equal(byPlayer['旗手怜央'].jfwRating, 6.0);
  assert.equal(byPlayer['旗手怜央'].ratingConfidence, 'medium');

  assert.equal(byPlayer['佐藤龍之介'].round, '第1節');
  assert.equal(byPlayer['佐藤龍之介'].values.keyPasses, 1);
  assert.equal(byPlayer['佐藤龍之介'].values.passesCompleted, 18);
  assert.equal(byPlayer['佐藤龍之介'].values.passesAttempted, 20);
  assert.equal(byPlayer['佐藤龍之介'].values.tackles, 1);
  assert.equal(byPlayer['佐藤龍之介'].ratingConflicts[0].field, 'keyPasses');
  assert.equal(byPlayer['佐藤龍之介'].ratingConflicts[0].rejected.value, 0);
});

test('stored Aug 26 ratings exactly match JFW Rating v1.0 engine output', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-26-2.json');
  const engine = loadRatingEngine();
  const expectedPlayers = ['田中碧', '坂元達裕', '旗手怜央', '佐藤龍之介'];

  for (const player of expectedPlayers) {
    const record = fragment.playerMatchStats.find((r) => r.player === player);
    assert.ok(record, player);
    const computed = plain(engine.compute(record.ratingInputs, record.ratingPosition));
    assert.equal(computed.jfwRating, record.jfwRating, `${player} rating`);
    assert.equal(computed.ratingCoverage, record.ratingCoverage, `${player} coverage`);
    assert.equal(computed.ratingConfidence, record.ratingConfidence, `${player} confidence`);
    assert.deepEqual(computed.ratingFactors, record.ratingFactors, `${player} factors`);
    assert.equal(computed.deltaPerformance, record.deltaPerformance, `${player} performance`);
    assert.equal(computed.deltaDiscipline, record.deltaDiscipline, `${player} discipline`);
    assert.deepEqual(computed.ratingBreakdown, record.ratingBreakdown, `${player} breakdown`);
  }

  const sato = fragment.playerMatchStats.find((r) => r.player === '佐藤龍之介');
  assert.equal(sato.jfwRating, 5.99);
  assert.equal(sato.ratingCoverage, 0.791);
  assert.equal(sato.ratingConfidence, 'high');
});

test('manifest and snapshot retain prior checks and append the consolidated overlay', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');
  const name = 'latest-2026-08-26-2.json';

  assert.equal(manifest.fragments.at(-1), name);
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.morishitaCarabaoAssistPreserved, true);
  assert.equal(snapshot.validation.moritaCarabaoStartAnd59MinuteSubstitutionPreserved, true);
  assert.equal(snapshot.validation.iwataCarabao83MinuteSubstitutionPreserved, true);
  assert.equal(snapshot.validation.maedaCarabaoBenchAndSubstitutionPreserved, true);
  assert.equal(snapshot.validation.satoBetisRoundIsLaLigaJornada1, true);
  assert.equal(snapshot.validation.satoBetisKeyPassConflictPreserved, true);
  assert.equal(snapshot.validation.satoBetisRatingIs599HighConfidence, true);
});
