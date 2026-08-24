const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function makeElement() {
  return {
    textContent: '', innerHTML: '', dataset: {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    appendChild() {}, insertAdjacentElement() {}
  };
}

async function loadCurrent() {
  const seasons = readJson('seasons.json');
  const season = seasons.seasons.find(item => item.id === seasons.current);
  const context = {
    console,
    window: {},
    document: { body: makeElement(), querySelector() { return null; }, createElement() { return makeElement(); } },
    D: readJson(season.data), selectedSeason: seasons.current,
    fetch: async url => {
      const clean = String(url).replace(/[?&]v=\d+$/, '').replace(/^\.\//, '');
      const file = path.join(ROOT, clean);
      if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
    },
    setTimeout, clearTimeout
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8'), context, { filename: 'backfill-loader.js' });
  await context.window.JFWBackfill.applyCurrentBackfill();
  return context.D;
}

test('Satoshi Tanaka is restored to the current Schalke/Bundesliga tracked player master', async () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const fragment = readJson('data/2026-27/backfill/latest-2026-08-24-11.json');
  const snapshot = readJson('state/latest_snapshot.json');

  assert.ok(manifest.fragments.includes('latest-2026-08-24-11.json'));
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.bundesligaSchalkeSatoshiTanakaMembershipLoadsThroughPlayerUpdates, true);

  const update = fragment.playerUpdates.find(player => player.name === '田中聡');
  assert.ok(update);
  assert.equal(update.club, 'シャルケ04');
  assert.equal(update.league, 'ブンデスリーガ');
  assert.equal(update.pos, 'MF');
  assert.equal(update.squadNumber, 13);
  assert.equal(update.previousClub, 'フォルトゥナ・デュッセルドルフ');
  assert.equal(update.contractUntil, '2030-06-30');
  assert.equal(update.priorityUpdate, true);

  const data = await loadCurrent();
  const player = data.players.find(item => item.name === '田中聡');
  assert.ok(player, '田中聡 must exist after applying current backfill');
  assert.ok(player.playerId, 'stable playerId must be assigned');
  assert.equal(player.club, 'シャルケ04');
  assert.equal(player.league, 'ブンデスリーガ');
  assert.equal(player.trackingStatus, 'active');
  assert.equal(player.squadNumber, 13);
  assert.equal(player.previousClub, 'フォルトゥナ・デュッセルドルフ');
  assert.ok(Array.isArray(player.membershipHistory));
  assert.equal(player.membershipHistory.filter(row => !row.to).length, 1);
});
