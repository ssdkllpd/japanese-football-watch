const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('Koki Machida current Hoffenheim membership and verified cup absence are registered without inventing stats', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const membershipFragment = readJson('data/2026-27/backfill/latest-2026-08-24-9.json');
  const matchFragment = readJson('data/2026-27/backfill/latest-2026-08-24-10.json');
  const snapshot = readJson('state/latest_snapshot.json');

  assert.ok(manifest.fragments.includes('latest-2026-08-24-9.json'));
  assert.ok(manifest.fragments.includes('latest-2026-08-24-10.json'));
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.bundesligaHoffenheimMachidaMembershipLoadsThroughPlayerUpdates, true);
  assert.equal(snapshot.validation.bundesligaHoffenheimMachidaCupAbsenceLoadsThroughPlayerMatchStats, true);

  const membership = membershipFragment.playerUpdates.find(player => player.name === '町田浩樹');
  assert.ok(membership);
  assert.equal(membership.club, 'ホッフェンハイム');
  assert.equal(membership.league, 'ブンデスリーガ');
  assert.equal(membership.pos, 'DF');
  assert.equal(membership.squadNumber, 28);

  const status = matchFragment.playerUpdates.find(player => player.name === '町田浩樹');
  assert.ok(status);
  assert.equal(status.priorityUpdate, true);
  assert.deepEqual(status.priorityFields, ['apiFootballPlayerId', 'current injury/availability status']);

  const record = matchFragment.playerMatchStats.find(item => item.player === '町田浩樹');
  assert.ok(record);
  assert.equal(record.appearance, 'absent_not_in_squad');
  assert.equal(record.values.minutes, 0);
  assert.equal(record.start, false);
  assert.equal(record.bench, false);
  assert.equal(record.jfwRating, null);
  assert.equal(record.priorityUpdate, false);
});
