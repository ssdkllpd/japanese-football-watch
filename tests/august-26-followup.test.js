'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('Aug 26 follow-up preserves verified Leeds and Valencia facts without inventing rating inputs', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-26-2.json');
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');

  assert.ok(manifest.fragments.includes('latest-2026-08-26-2.json'));
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.aug26FollowupOverlayPresent, true);

  const tanaka = fragment.playerMatchStats.find(row => row.recordId === 'r-aotanaka-forest-leeds-20260825');
  assert.ok(tanaka);
  assert.equal(tanaka.values.minutes, 68);
  assert.equal(tanaka.values.goals, 0);
  assert.equal(tanaka.values.assists, 0);
  assert.equal(tanaka.ratingInputs.yellowCards.state, 'missing');
  assert.equal(tanaka.ratingInputs.penaltiesConceded.state, 'missing');
  assert.equal(tanaka.jfwRating, null);
  assert.equal(tanaka.priorityUpdate, true);

  const sato = fragment.playerMatchStats.find(row => row.recordId === 'r-sato-valencia-betis-20260825');
  assert.ok(sato);
  assert.equal(sato.values.minutes, 90);
  assert.equal(sato.values.goals, 0);
  assert.equal(sato.values.assists, 0);
  assert.equal(sato.values.yellowCards, 1);
  assert.equal(sato.ratingInputs.secondYellowRed.state, 'missing');
  assert.equal(sato.ratingInputs.penaltiesConceded.state, 'missing');
  assert.equal(sato.ratingInputs.ownGoals.state, 'missing');
  assert.equal(sato.jfwRating, null);
  assert.equal(sato.priorityUpdate, true);
});
