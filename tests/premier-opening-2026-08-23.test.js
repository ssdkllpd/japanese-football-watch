const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const fragmentPath = 'data/2026-27/backfill/latest-2026-08-23.json';

test('August 23 Premier League fragment is registered and retains missing Rating inputs', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const fragment = readJson(fragmentPath);

  assert.equal(manifest.fragments.at(-1), 'latest-2026-08-23.json');

  const byPlayer = new Map(fragment.playerMatchStats.map(record => [record.player, record]));
  for (const player of ['坂元達裕', '鎌田大地', '冨安健洋', '前田大然', '田中碧']) {
    assert.ok(byPlayer.has(player), `${player} match record must exist`);
    assert.equal(byPlayer.get(player).jfwRating, null);
    assert.equal(byPlayer.get(player).ratingVersion, '1.0');
  }

  assert.equal(byPlayer.get('坂元達裕').values.minutes, 0);
  assert.equal(byPlayer.get('田中碧').values.minutes, 0);
  assert.equal(byPlayer.get('前田大然').values.minutes, 80);
  assert.equal(byPlayer.get('鎌田大地').priorityUpdate, true);
  assert.ok(byPlayer.get('鎌田大地').priorityFields.includes('penaltiesConceded'));
  assert.equal(byPlayer.get('冨安健洋').priorityUpdate, true);
  assert.ok(byPlayer.get('冨安健洋').priorityFields.includes('gaOnPitch'));
  assert.equal(byPlayer.get('前田大然').priorityUpdate, true);
});

test('new completed Premier League fixtures are queued for API-Football detail backfill', () => {
  const config = readJson('config/api-football-existing-results.json');
  const ids = new Set(config.fixtures.map(fixture => fixture.matchId));

  for (const id of [
    'premier-2026-08-22-everton-palace',
    'premier-2026-08-22-ipswich-sunderland',
    'premier-2026-08-22-forest-leeds'
  ]) {
    assert.ok(ids.has(id), `${id} must be an API-Football backfill target`);
  }
});
