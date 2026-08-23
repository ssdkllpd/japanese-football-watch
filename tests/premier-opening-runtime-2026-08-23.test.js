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
    document: {
      body: makeElement(), querySelector() { return null; },
      createElement() { return makeElement(); }
    },
    D: structuredClone(base),
    selectedSeason: '2026-27',
    loadSeason: async () => {},
    renderAll() {}, renderPlayerDetail() {}, renderClubDetail() {},
    renderAttention() {}, renderStats() {}, relevantClubMatches() { return []; },
    clubPlayers() { return []; }, clubMatchCard() { return ''; }, pcard() { return ''; },
    mcard() { return ''; }, bindEntities() {}, bindWatch() {}, btns() {},
    eligible() { return true; }, playerRef(p) { return p.playerId || p.name; },
    playerByRef(ref) { return context.D.players.find(p => p.playerId === ref || p.name === ref); },
    roundNo() { return null; }, fmt(v) { return v == null ? '—' : String(v); },
    E(v) { return String(v ?? ''); }, $() { return makeElement(); },
    R: { updated: makeElement(), leagueBtns: makeElement(), players: makeElement(), scopeBtns: makeElement(), metricBtns: makeElement(), statRank: makeElement(), playerDetail: makeElement(), clubDetail: makeElement() },
    order: ['すべて', 'プレミアリーグ'], scope: 'すべて', metric: 'goals', metrics: { goals: '得点' },
    attLeague: 'すべて', page: 'home', activePlayer: null, activeClub: null,
    clubRoundFrom: null, clubRoundTo: null, clearDetailParams() {}, showPage() {}, lastPage: 'home',
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
  const source = fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'backfill-loader.js' });
  return context;
}

test('runtime backfill exposes verified Premier League opening-round records and only computes supported ratings', async () => {
  const context = buildHarness();
  await context.window.JFWBackfill.applyCurrentBackfill();
  const merged = context.D;

  const expectedMatches = new Map([
    ['premier-2026-08-22-everton-palace', 'エヴァートン 2-0 クリスタル・パレス'],
    ['premier-2026-08-22-ipswich-sunderland', 'イプスウィッチ・タウン 2-1 サンダーランド'],
    ['premier-2026-08-22-forest-leeds', 'ノッティンガム・フォレスト 0-1 リーズ・ユナイテッド']
  ]);
  for (const [matchId, label] of expectedMatches) {
    const match = merged.matches.find(item => item.matchId === matchId);
    assert.ok(match, `${matchId} must load through the runtime backfill`);
    assert.equal(match.match, label);
  }

  const records = merged.playerMatchStats.filter(record => expectedMatches.has(record.matchId));
  const kamada = records.find(record => record.player === '鎌田大地');
  const tomiyasu = records.find(record => record.player === '冨安健洋');
  const maeda = records.find(record => record.player === '前田大然');
  const tanaka = records.find(record => record.player === '田中碧');

  assert.ok(kamada?.start === true);
  assert.equal(kamada.jfwRating, 6.3);
  assert.equal(kamada.ratingCoverage, 0.755);
  assert.equal(kamada.ratingConfidence, 'high');
  assert.deepEqual(Array.from(kamada.priorityFields || []), ['tackles', 'interceptions', 'duelsWon', 'duelsTotal']);

  assert.ok(tomiyasu?.substitution?.on === 72);
  assert.equal(tomiyasu.jfwRating, 6.25);
  assert.ok(maeda?.minutes === 80);
  assert.equal(maeda.jfwRating, null);
  assert.ok(tanaka?.minutes === 0);
  assert.equal(tanaka.jfwRating, null);
});
