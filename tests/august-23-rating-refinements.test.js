const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadRating() {
  const sandbox = {
    window: { addEventListener() {} },
    console,
    setTimeout() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('jfw-rating.js', 'utf8'), sandbox);
  return sandbox.window.JFWRating;
}

function inputsFromRecord(record) {
  const inputs = {};
  for (const [field, value] of Object.entries(record.values || {})) inputs[field] = { state: 'value', value };
  for (const field of record.missingFields || []) if (!inputs[field]) inputs[field] = { state: 'missing' };
  return inputs;
}

const fragment = JSON.parse(fs.readFileSync('data/2026-27/backfill/latest-2026-08-23-8.json', 'utf8'));
const byId = Object.fromEntries(fragment.playerMatchStats.map(record => [record.recordId, record]));
const rating = loadRating();

test('August 23 Palace rating refinements are reproducible', () => {
  const kamada = rating.compute(inputsFromRecord(byId['r-kamada-everton-palace-20260822']), 'MF');
  assert.equal(kamada.jfwRating, 5.8);
  assert.equal(kamada.ratingCoverage, 0.447);
  assert.equal(kamada.ratingConfidence, 'medium');
  const tomiyasu = rating.compute(inputsFromRecord(byId['r-tomiyasu-everton-palace-20260822']), 'DF');
  assert.equal(tomiyasu.jfwRating, 6.25);
  assert.equal(tomiyasu.ratingCoverage, 0.481);
  assert.equal(tomiyasu.ratingConfidence, 'medium');
});

test('August 23 Antwerp-Genk rating refinements are reproducible', () => {
  const yokoyama = rating.compute(inputsFromRecord(byId['r-yokoyama-genk-antwerp-20260822']), 'FW');
  assert.equal(yokoyama.jfwRating, 6.82);
  const ito = rating.compute(inputsFromRecord(byId['r-ito-genk-antwerp-20260822']), 'FW');
  assert.equal(ito.jfwRating, 6);
  const tsunashima = rating.compute(inputsFromRecord(byId['r-tsunashima-antwerp-genk-20260822']), 'DF');
  assert.equal(tsunashima.jfwRating, 5.32);
  const nozawa = rating.compute(inputsFromRecord(byId['r-nozawa-antwerp-genk-20260822']), 'GK');
  assert.equal(nozawa.jfwRating, 5.42);
  assert.equal(nozawa.ratingConfidence, 'low');
});

test('retained snapshot matches the latest overlay manifest', () => {
  const manifest = JSON.parse(fs.readFileSync('data/2026-27/backfill/index.json', 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync('state/latest_snapshot.json', 'utf8'));
  assert.equal(manifest.fragments.at(-1), 'latest-2026-08-23-8.json');
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.snapshotManifestMatchesCurrentManifest, true);
});
