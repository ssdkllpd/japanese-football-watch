'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('Satoshi Tanaka Hallescher cup appearance is stored without guessing missing rating inputs', () => {
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-25-2.json');
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');

  assert.ok(manifest.fragments.includes('latest-2026-08-25-2.json'));
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.satoshiTanakaHalleCupAppearanceLoadsWithoutIncompleteRating, true);

  const match = fragment.matchUpdates.find(row => row.matchId === 'dfbpokal-2026-08-24-halle-schalke');
  assert.ok(match);
  assert.equal(match.status, 'verified');
  assert.match(match.match, /2-5/);

  const record = fragment.playerMatchStats.find(row => row.recordId === 'r-tanaka-halle-schalke-20260824');
  assert.ok(record);
  assert.equal(record.player, '田中聡');
  assert.equal(record.values.minutes, 15);
  assert.equal(record.values.goals, 0);
  assert.equal(record.values.assists, 0);
  assert.equal(record.ratingInputs.penaltiesConceded.state, 'missing');
  assert.equal(record.ratingInputs.ownGoals.state, 'missing');
  assert.equal(record.jfwRating, null);
  assert.equal(record.priorityUpdate, true);
});
