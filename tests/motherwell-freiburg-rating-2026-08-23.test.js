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

test('Motherwell-Freiburg required gates produce stored JFW ratings using already-collected API stats without zero-filling gaps', async () => {
  const context = buildHarness();
  await context.window.JFWBackfill.applyCurrentBackfill();
  const rows = context.D.playerMatchStats.filter(r => r.matchId === 'uecl-2026-08-20-motherwell-freiburg');
  const suzuki = rows.find(r => r.playerId === 'jp-fwd2e8');
  const goto = rows.find(r => r.playerId === 'jp-19l4emr');

  assert.ok(suzuki);
  assert.equal(suzuki.minutes, 74);
  assert.equal(suzuki.ratingInputs.shots?.value, 2);
  assert.equal(suzuki.ratingInputs.shotsOnTarget?.value, 1);
  assert.equal(suzuki.ratingInputs.duelsWon?.value, 3);
  assert.equal(suzuki.ratingInputs.duelsTotal?.value, 7);
  assert.equal(suzuki.ratingInputs.passesCompleted?.value, 16);
  assert.equal(suzuki.ratingInputs.passesAttempted?.value, 25);
  assert.equal(suzuki.jfwRating, 5.93);
  assert.equal(suzuki.ratingCoverage, 0.571);
  assert.equal(suzuki.ratingConfidence, 'medium');
  for (const field of ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals']) {
    assert.equal(suzuki.ratingInputs[field]?.state, 'value');
    assert.equal(suzuki.ratingInputs[field]?.value, 0);
  }
  assert.equal(suzuki.ratingInputs.keyPasses?.state, 'missing');
  assert.equal(suzuki.priorityUpdate, true);
  assert.ok(!suzuki.priorityFields.includes('duelsWon'));
  assert.ok(!suzuki.priorityFields.includes('passesAttempted'));

  assert.ok(goto);
  assert.equal(goto.minutes, 10);
  assert.equal(goto.ratingInputs.goals?.value, 1);
  assert.equal(goto.ratingInputs.shots?.value, 1);
  assert.equal(goto.ratingInputs.shotsOnTarget?.value, 1);
  assert.equal(goto.ratingInputs.duelsTotal?.value, 1);
  assert.equal(goto.ratingInputs.passesCompleted?.value, 1);
  assert.equal(goto.ratingInputs.passesAttempted?.value, 1);
  assert.equal(goto.jfwRating, 6.45);
  assert.equal(goto.ratingCoverage, 0.712);
  assert.equal(goto.ratingConfidence, 'medium');
  for (const field of ['yellowCards','secondYellowRed','straightRed','penaltiesConceded','ownGoals']) {
    assert.equal(goto.ratingInputs[field]?.state, 'value');
    assert.equal(goto.ratingInputs[field]?.value, 0);
  }
  assert.equal(goto.ratingInputs.keyPasses?.state, 'missing');
  assert.equal(goto.ratingInputs.duelsWon?.state, 'missing');
  assert.equal(goto.priorityUpdate, true);
  assert.ok(!goto.priorityFields.includes('shots'));
  assert.ok(!goto.priorityFields.includes('shotsOnTarget'));
});

test('snapshot retains the Motherwell refinement while mirroring the current append-only manifest', () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const snapshot = readJson('state/latest_snapshot.json');
  assert.ok(manifest.fragments.includes('latest-2026-08-23-11.json'));
  assert.deepEqual(snapshot.overlayManifest.orderedFragments, manifest.fragments);
  assert.equal(snapshot.validation.motherwellFreiburgRatingsRefined, true);
});
