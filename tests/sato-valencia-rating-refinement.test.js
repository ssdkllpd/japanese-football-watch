const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'));
}

test('Sato Valencia debut refinement keeps verified rating inputs and unresolved fields distinct', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-23-5.json');
  const record = fragment.playerMatchStats.find((item) => item.recordId === 'r-sato-valencia-celta-20260822');
  assert.ok(record);
  assert.equal(record.values.minutes, 56);
  assert.deepEqual(record.substitution, { off: 56 });
  assert.equal(record.ratingInputs.minutes.state, 'value');
  assert.equal(record.ratingInputs.minutes.value, 56);

  for (const field of ['yellowCards', 'secondYellowRed', 'straightRed', 'penaltiesConceded', 'ownGoals']) {
    assert.equal(record.ratingInputs[field].state, 'value');
    assert.equal(record.ratingInputs[field].value, 0);
  }

  for (const field of ['keyPasses', 'passesCompleted', 'passesAttempted', 'tackles', 'interceptions', 'duelsWon', 'duelsTotal', 'dribbles', 'possessionsLost']) {
    assert.equal(record.ratingInputs[field].state, 'missing');
  }

  assert.equal(record.jfwRating, 6.0);
  assert.equal(record.ratingVersion, '1.0');
  assert.equal(record.ratingCoverage, 0.447);
  assert.equal(record.ratingConfidence, 'medium');
  assert.equal(record.priorityUpdate, true);
  assert.ok(record.priorityFields.includes('passesAttempted'));
  assert.ok(!record.priorityFields.includes('minutes'));
  assert.ok(!record.priorityFields.includes('yellowCards'));
});

test('snapshot and manifest both include the Sato refinement fragment', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');
  assert.equal(manifest.fragments.at(-1), 'latest-2026-08-23-5.json');
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.laligaSatoRatingRefinementLoadsThroughPlayerMatchStats, true);
  assert.match(snapshot.verifiedCorrections.join('\n'), /JFW Rating v1\.0 = 6\.00/);
});
