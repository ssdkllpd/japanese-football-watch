const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const fragmentPath = 'data/2026-27/backfill/latest-2026-08-24-2.json';

test('August 24 follow-up fragment is registered and preserves missing Rating inputs', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const fragment = readJson(fragmentPath);
  assert.ok(manifest.fragments.includes('latest-2026-08-24-2.json'));

  const byPlayer = new Map(fragment.playerMatchStats.map(record => [record.player, record]));
  const hashioka = byPlayer.get('橋岡大樹');
  const sano = byPlayer.get('佐野航大');

  assert.ok(hashioka);
  assert.equal(hashioka.values.goals, 1);
  assert.equal(hashioka.ratingInputs.goals.state, 'value');
  assert.equal(hashioka.ratingInputs.minutes.state, 'missing');
  assert.equal(hashioka.jfwRating, null);
  assert.equal(hashioka.priorityUpdate, true);

  assert.ok(sano);
  assert.equal(sano.appearance, 'starter');
  assert.equal(sano.ratingInputs.minutes.state, 'missing');
  assert.equal(sano.ratingInputs.goals.state, 'missing');
  assert.equal(sano.jfwRating, null);
  assert.equal(sano.priorityUpdate, true);
});

test('August 24 completed matches are queued for API detail backfill and snapshot mirrors manifest', () => {
  const api = readJson('config/api-football-existing-results.json');
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');
  const fixtureIds = new Set(api.fixtures.map(fixture => fixture.matchId));

  assert.ok(fixtureIds.has('dfbpokal-2026-08-23-schott-mainz-gladbach'));
  assert.ok(fixtureIds.has('eredivisie-2026-08-23-psv-groningen'));
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.bundesligaHashiokaCupGoalLoadsThroughPlayerMatchStats, true);
  assert.equal(snapshot.validation.eredivisieSanoFirstStartLoadsThroughPlayerMatchStats, true);
});
