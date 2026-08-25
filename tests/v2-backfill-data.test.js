const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mergeBackfillData } = require('../backfill-merge');
const { loadCurrentMergedData } = require('../v2-backfill-data');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function repositoryJson() {
  return async rel => readJson(rel);
}

function withoutIntegrity(value) {
  const copy = JSON.parse(JSON.stringify(value));
  delete copy._dataIntegrity;
  return copy;
}

test('v2 loader follows seasons.json and returns the current merged backfill data', async () => {
  const catalog = readJson('seasons.json');
  const season = catalog.current;
  const descriptor = catalog.seasons.find(item => item.id === season);
  const manifest = readJson(`data/${season}/backfill/index.json`);
  const base = readJson(descriptor.data);
  const fragments = manifest.fragments.map(name => readJson(`data/${season}/backfill/${name}`));
  const expected = mergeBackfillData(base, fragments, { season });

  const loaded = await loadCurrentMergedData({
    getJson: repositoryJson(),
    mergeBackfillData,
  });

  assert.deepEqual(withoutIntegrity(loaded), expected);
  assert.equal(loaded._dataIntegrity.degraded, false);
  assert.equal(loaded._dataIntegrity.season, season);
  assert.equal(loaded._dataIntegrity.fragmentsExpected, manifest.fragments.length);
  assert.equal(loaded._dataIntegrity.fragmentsLoaded, manifest.fragments.length);

  assert.ok(loaded.players.length >= 56);
  assert.ok(loaded.matches.length >= 27);
  assert.ok(loaded.playerMatchStats.length >= 61);
  assert.ok(loaded.players.filter(player => player.photo).length >= 27);
  const ito = loaded.players.find(player => player.name === '伊東純也');
  assert.ok(ito);
  assert.ok(Number(ito.seasonStats?.assists) >= 2);
});

test('v2 loader fails visibly to raw data when a fragment cannot be fetched', async () => {
  const catalog = readJson('seasons.json');
  const season = catalog.current;
  const descriptor = catalog.seasons.find(item => item.id === season);
  const base = readJson(descriptor.data);
  const manifestPath = `data/${season}/backfill/index.json`;
  const manifest = readJson(manifestPath);
  const missingPath = `data/${season}/backfill/${manifest.fragments[0]}`;

  const loaded = await loadCurrentMergedData({
    getJson: async rel => {
      if (rel === missingPath) throw new Error('simulated fragment failure');
      return readJson(rel);
    },
    mergeBackfillData,
  });

  assert.equal(loaded._dataIntegrity.degraded, true);
  assert.equal(loaded._dataIntegrity.season, season);
  assert.equal(loaded._dataIntegrity.manifestPath, manifestPath);
  assert.equal(loaded._dataIntegrity.fragmentsExpected, manifest.fragments.length);
  assert.deepEqual(withoutIntegrity(loaded), base);
  assert.match(loaded._dataIntegrity.errors.join('\n'), /simulated fragment failure/);
});

test('v2 loader marks missing merge core as degraded instead of silently claiming parity', async () => {
  const loaded = await loadCurrentMergedData({ getJson: repositoryJson() });

  assert.equal(loaded._dataIntegrity.degraded, true);
  assert.match(loaded._dataIntegrity.errors.join('\n'), /merge core/);
  assert.equal(loaded.players.length, readJson('data.json').players.length);
});
