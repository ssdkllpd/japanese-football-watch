const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

test('Takai opening-match absence is integrated and resumable', () => {
  const fragmentName = 'latest-2026-08-23-9.json';
  const fragment = readJson(`data/2026-27/backfill/${fragmentName}`);
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');
  const apiTargets = readJson('config/api-football-existing-results.json');

  assert.ok(manifest.fragments.includes(fragmentName));
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);

  const record = fragment.playerMatchStats.find((item) => item.recordId === 'r-takai-brentford-tottenham-20260822');
  assert.ok(record);
  assert.equal(record.appearance, 'absent_not_in_squad');
  assert.equal(record.values.minutes, 0);
  assert.equal(record.jfwRating, null);
  assert.equal(record.priorityUpdate, false);

  assert.ok(apiTargets.fixtures.some((item) => item.matchId === 'premier-2026-08-22-brentford-tottenham'));
  assert.ok(apiTargets.fixtureDiscoveryGroups.some((item) => item.key === 'tottenham' && item.matchIds.includes('premier-2026-08-22-brentford-tottenham')));
  assert.deepEqual(apiTargets.playerAliases['高井幸大'], ['Kota Takai', 'K. Takai']);
});
