const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compactSeason } = require('../scripts/compact-season');
const { loadIntegratedSeasonData } = require('../scripts/shared/runtime-data-loader');

const ROOT = path.join(__dirname, '..');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-compact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(ROOT, 'backfill-loader.js'), path.join(root, 'backfill-loader.js'));

  const season = 'test-season';
  writeJson(path.join(root, 'seasons.json'), {
    current: season,
    seasons: [{ id: season, data: `data/${season}/base.json` }],
  });
  writeJson(path.join(root, 'config/player-registry.json'), {
    schemaVersion: 1,
    players: [{ playerId: 'jp-test', name: 'テスト選手', aliases: [], providerIds: {} }],
  });
  writeJson(path.join(root, `data/${season}/base.json`), {
    updated: '2026-08-01 00:00 JST',
    players: [{
      playerId: 'jp-test',
      name: 'テスト選手',
      club: 'Club A',
      league: 'プレミアリーグ',
      statsAsOf: '開幕前',
      stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 },
    }],
    matches: [],
    topMatches: [],
    playerMatchStats: [],
    gaResults: [],
  });
  writeJson(path.join(root, `data/${season}/backfill/index.json`), { fragments: ['one.json'] });
  writeJson(path.join(root, `data/${season}/backfill/one.json`), {
    updated: '2026-08-20 12:00 JST',
    matchUpdates: [{
      matchId: 'm1', league: 'プレミアリーグ', ko: '2026-08-20 20:00',
      match: 'Club A 1-0 Club B', addIfMissing: true,
    }],
    playerMatchStats: [{
      recordId: 'm1-p', matchId: 'm1', playerId: 'jp-test', player: 'テスト選手',
      club: 'Club A', competition: 'プレミアリーグ', appearance: true, start: true,
      values: { minutes: 90, goals: 1, assists: 0 }, missingFields: [],
    }],
  });
  return { root, season };
}

function withoutCompaction(value) {
  const clone = JSON.parse(JSON.stringify(value));
  delete clone.compaction;
  return clone;
}

test('load(compact(X)) preserves integrated runtime data and statsAsOf is idempotent', async t => {
  const { root, season } = fixtureRoot(t);
  const before = await loadIntegratedSeasonData(root, season);
  assert.equal(before.players[0].statsAsOf, '開幕前 / シーズン通算（クラブ別保持）');
  assert.equal(before.players[0].seasonStats.goals, 1);

  const result = await compactSeason({
    root,
    season,
    apply: true,
    force: true,
    compactedAt: '2026-08-21T10:00:00.000Z',
  });
  assert.equal(result.applied, true);

  const after = await loadIntegratedSeasonData(root, season);
  assert.deepEqual(withoutCompaction(after), withoutCompaction(before));
  assert.equal(after.players[0].statsAsOf, '開幕前 / シーズン通算（クラブ別保持）');
  assert.equal(after.players[0].seasonStats.goals, 1);
  assert.deepEqual(after.compaction.compactedThroughFragments, ['one.json']);
});

test('second compaction with no new fragments is a no-op and retains audit chain', async t => {
  const { root, season } = fixtureRoot(t);
  await compactSeason({
    root,
    season,
    apply: true,
    force: true,
    compactedAt: '2026-08-21T10:00:00.000Z',
  });

  const basePath = path.join(root, `data/${season}/compacted/base.json`);
  const manifestPath = path.join(root, `data/${season}/backfill/index.json`);
  const seasonsPath = path.join(root, 'seasons.json');
  const before = {
    base: fs.readFileSync(basePath, 'utf8'),
    manifest: fs.readFileSync(manifestPath, 'utf8'),
    seasons: fs.readFileSync(seasonsPath, 'utf8'),
  };

  const result = await compactSeason({
    root,
    season,
    apply: true,
    force: true,
    compactedAt: '2026-08-21T11:00:00.000Z',
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'no_new_fragments');
  assert.equal(fs.readFileSync(basePath, 'utf8'), before.base);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), before.manifest);
  assert.equal(fs.readFileSync(seasonsPath, 'utf8'), before.seasons);

  const manifest = JSON.parse(before.manifest);
  const base = JSON.parse(before.base);
  assert.deepEqual(manifest.compaction.archivedFragments, ['one.json']);
  assert.deepEqual(base.compaction.compactedThroughFragments, ['one.json']);
});
