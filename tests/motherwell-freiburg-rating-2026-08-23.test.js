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

function buildHarness() {
  const base = readJson('data.json');
  const manifest = readJson('data/2026-27/backfill/index.json');
  const fragmentsByName = new Map(manifest.fragments.map(name => [name, readJson(`data/2026-27/backfill/${name}`)]));
  const context = {
    console,
    window: {},
    document: { body: makeElement(), querySelector() { return null; }, createElement() { return makeElement(); } },
    D: structuredClone(base), selectedSeason: '2026-27', loadSeason: async () => {},
    renderAll() {}, renderPlayerDetail() {}, renderClubDetail() {}, renderAttention() {}, renderStats() {},
    relevantClubMatches() { return []; }, clubPlayers() { return []; }, clubMatchCard() { return ''; },
    pcard() { return ''; }, mcard() { return ''; }, bindEntities() {}, bindWatch() {}, btns() {}, eligible() { return true; },
    playerRef(p) { return p.playerId || p.name; },
    playerByRef(ref) { return context.D.players.find(p => p.playerId === ref || p.name === ref); },
    roundNo() { return null; }, fmt(v) { return v == null ? '—' : String(v); }, E(v) { return String(v ?? ''); },
    $() { return makeElement(); },
    R: { updated: makeElement(), leagueBtns: makeElement(), players: makeElement(), scopeBtns: makeElement(), metricBtns: makeElement(), statRank: makeElement(), playerDetail: makeElement(), clubDetail: makeElement() },
    order: ['すべて', 'ブンデスリーガ'], scope: 'すべて', metric: 'goals', metrics: { goals: '得点' },
    attLeague: 'すべて', page: 'home', activePlayer: null, activeClub: null, clubRoundFrom: null, clubRoundTo: null,
    clearDetailParams() {}, showPage() {}, lastPage: 'home',
    fetch: async url => {
      const value = String(url).split('?')[0];
      if (value.endsWith('/index.json')) return { ok: true, json: async () => manifest };
      const name = value.split('/').at(-1);
      if (fragmentsByName.has(name)) return { ok: true, json: async () => fragmentsByName.get(name) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
    setTimeout, clearTimeout
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8'), context, { filename: 'backfill-loader.js' });
  return context;
}

test('Motherwell-Freiburg required gates produce stored JFW ratings without zero-filling advanced inputs', async () => {
  const context = buildHarness();
  await context.window.JFWBackfill.applyCurrentBackfill();
  const rows = context.D.playerMatchStats.filter(r => r.matchId === 'uecl-2026-08-20-motherwell-freiburg');
  const suzuki = rows.find(r => r.playerId === 'jp-fwd2e8');
  const goto = rows.find(r => r.playerId === 'jp-19l4emr');

  assert.ok(suzuki);
  assert.equal(suzuki.minutes, 74);
  assert.equal(suzuki.jfwRating, 6.0);
  assert.equal(suzuki.ratingCoverage, 0.447);
  assert.equal(suzuki.ratingConfidence, 'medium');
  for (const field of ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals']) {
    assert.equal(suzuki.ratingInputs[field]?.state, 'value');
    assert.equal(suzuki.ratingInputs[field]?.value, 0);
  }
  assert.equal(suzuki.ratingInputs.keyPasses?.state, 'missing');
  assert.equal(suzuki.priorityUpdate, true);

  assert.ok(goto);
  assert.equal(goto.minutes, 10);
  assert.equal(goto.ratingInputs.goals?.value, 1);
  assert.equal(goto.jfwRating, 6.35);
  assert.equal(goto.ratingCoverage, 0.513);
  assert.equal(goto.ratingConfidence, 'medium');
  for (const field of ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals']) {
    assert.equal(goto.ratingInputs[field]?.state, 'value');
    assert.equal(goto.ratingInputs[field]?.value, 0);
  }
  assert.equal(goto.ratingInputs.shots?.state, 'missing');
  assert.equal(goto.priorityUpdate, true);
});

test('snapshot mirrors the Motherwell refinement manifest', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');
  assert.equal(manifest.fragments.at(-1), 'latest-2026-08-23-11.json');
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.motherwellFreiburgRatingsRefined, true);
});
