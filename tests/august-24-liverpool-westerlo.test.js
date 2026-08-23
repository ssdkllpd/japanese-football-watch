const test = require('node:test');
const assert = require('node:assert/strict');

const fragment = require('../data/2026-27/backfill/latest-2026-08-24-6.json');
const manifest = require('../data/2026-27/backfill/index.json');
const apiManifest = require('../config/api-football-existing-results.json');
const snapshot = require('../state/latest_snapshot.json');

function record(player) {
  return fragment.playerMatchStats.find((entry) => entry.player === player);
}

test('Liverpool opening match keeps Endo unused and unrated', () => {
  const endo = record('遠藤航');
  assert.ok(endo);
  assert.equal(endo.appearance, 'bench_unused');
  assert.equal(endo.values.minutes, 0);
  assert.equal(endo.jfwRating, null);
  assert.equal(endo.priorityUpdate, false);
});

test('Westerlo Japanese appearances retain unresolved discipline as missing', () => {
  const kimura = record('木村誠二');
  const saito = record('齋藤俊輔');
  const sakamoto = record('坂本一彩');
  assert.equal(kimura.values.minutes, 90);
  assert.equal(kimura.values.gaOnPitch, 4);
  assert.equal(kimura.ratingInputs.yellowCards.state, 'missing');
  assert.equal(kimura.jfwRating, null);
  assert.equal(kimura.priorityUpdate, true);
  assert.equal(saito.values.minutes, 45);
  assert.equal(saito.ratingInputs.yellowCards.state, 'missing');
  assert.equal(saito.jfwRating, null);
  assert.equal(sakamoto.values.minutes, 75);
  assert.equal(sakamoto.ratingInputs.yellowCards.state, 'missing');
  assert.equal(sakamoto.jfwRating, null);
});

test('new fixtures are queued for provider detail backfill', () => {
  const fixtureIds = new Set(apiManifest.fixtures.map((fixture) => fixture.matchId));
  assert.ok(fixtureIds.has('premier-2026-08-23-newcastle-liverpool'));
  assert.ok(fixtureIds.has('belgium-2026-08-23-lommel-westerlo'));
  assert.deepEqual(apiManifest.playerAliases['遠藤航'], ['Wataru Endo', 'W. Endo']);
});

test('manifest and retained snapshot include the same newest fragment', () => {
  assert.equal(manifest.fragments.at(-1), 'latest-2026-08-24-6.json');
  assert.equal(snapshot.overlayManifest.orderedFragments.at(-1), manifest.fragments.at(-1));
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
});
