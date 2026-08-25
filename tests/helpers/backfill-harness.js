const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function currentSeasonData() {
  const manifest = readJson('seasons.json');
  const season = manifest.seasons.find(item => item.id === manifest.current);
  assert.ok(season, 'current season must resolve from seasons.json');
  return {
    season: manifest.current,
    data: readJson(season.data)
  };
}

function makeElement() {
  return {
    textContent: '',
    innerHTML: '',
    dataset: {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild() {},
    insertAdjacentElement() {}
  };
}

function fixtureFetch(fragments) {
  return async url => {
    const value = String(url);
    if (value.includes('index.json')) {
      return {
        ok: true,
        json: async () => ({ fragments: fragments.map((_, index) => `${index}.json`) })
      };
    }
    const match = value.match(/\/(\d+)\.json/);
    const index = match ? Number(match[1]) : -1;
    if (index >= 0 && fragments[index]) {
      return { ok: true, json: async () => fragments[index] };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function repositoryFetch() {
  return async url => {
    const clean = String(url).replace(/[?&]v=\d+$/, '').replace(/^\.\//, '');
    const file = path.join(ROOT, clean);
    if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
  };
}

function createBackfillContext(options = {}) {
  const current = options.data ? null : currentSeasonData();
  const season = options.season || current?.season || '2026-27';
  const data = options.data || current.data;
  const context = {
    console,
    window: {},
    document: {
      body: makeElement(),
      querySelector() { return null; },
      createElement() { return makeElement(); }
    },
    D: JSON.parse(JSON.stringify(data)),
    selectedSeason: season,
    loadSeason: async () => {},
    renderAll() {},
    renderPlayerDetail() {},
    renderClubDetail() {},
    renderAttention() {},
    renderStats() {},
    relevantClubMatches() { return []; },
    clubPlayers() { return []; },
    clubMatchCard() { return ''; },
    pcard() { return ''; },
    mcard() { return ''; },
    bindEntities() {},
    bindWatch() {},
    btns() {},
    eligible() { return true; },
    playerRef(player) { return player.playerId || player.name; },
    playerByRef(ref) { return context.D.players.find(player => player.playerId === ref || player.name === ref); },
    getData() { return context.D; },
    roundNo() { return null; },
    fmt(value) { return value == null ? '—' : String(value); },
    E(value) { return String(value ?? ''); },
    $() { return makeElement(); },
    R: {
      updated: makeElement(),
      leagueBtns: makeElement(),
      leagueTitle: makeElement(),
      players: makeElement(),
      scopeBtns: makeElement(),
      metricBtns: makeElement(),
      statRank: makeElement(),
      playerDetail: makeElement(),
      clubDetail: makeElement()
    },
    order: options.order || ['すべて','プレミアリーグ','チャンピオンシップ','ブンデスリーガ','ラ・リーガ','リーグ・アン','セリエA','エールディヴィジ','ベルギー','ポルトガル','スコットランド'],
    scope: 'すべて',
    metric: 'goals',
    metrics: { goals: '得点', assists: 'アシスト' },
    attLeague: 'すべて',
    page: 'home',
    activePlayer: null,
    activeClub: null,
    clubRoundFrom: null,
    clubRoundTo: null,
    clearDetailParams() {},
    showPage() {},
    lastPage: 'home',
    fetch: options.fragments ? fixtureFetch(options.fragments) : repositoryFetch(),
    setTimeout,
    clearTimeout,
    addEventListener() {}
  };

  context.window = context;
  vm.createContext(context);
  return context;
}

function buildBackfillHarness(options = {}) {
  const context = createBackfillContext(options);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-merge.js'), 'utf8'), context, { filename: 'backfill-merge.js' });
  if (options.loadRating) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'jfw-rating.js'), 'utf8'), context, { filename: 'jfw-rating.js' });
  }
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8'), context, { filename: 'backfill-loader.js' });
  return context;
}

module.exports = {
  ROOT,
  buildBackfillHarness,
  createBackfillContext,
  currentSeasonData,
  makeElement,
  readJson
};
