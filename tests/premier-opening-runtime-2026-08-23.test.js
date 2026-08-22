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

test('runtime backfill exposes verified Premier League opening-round records and only computes ratings after explicit gates resolve', async () => {
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

  const byRecordId = recordId => merged.playerMatchStats.find(record => record.recordId === recordId);
  const kamada = byRecordId('r-kamada-everton-palace-20260822');
  const tomiyasu = byRecordId('r-tomiyasu-everton-palace-20260822');
  const maeda = byRecordId('r-maeda-ipswich-sunderland-20260822');
  const tanaka = merged.playerMatchStats.find(record => record.matchId === 'premier-2026-08-22-forest-leeds' && record.player === '田中碧');

  assert.ok(kamada);
  assert.ok(tomiyasu);
  assert.ok(maeda);
  assert.ok(tanaka);

  assert.equal(kamada.start, true);
  assert.equal(kamada.jfwRating, 5.8);
  assert.equal(kamada.ratingCoverage, 0.447);
  assert.equal(kamada.ratingConfidence, 'medium');

  assert.equal(tomiyasu.substitution?.on, 72);
  assert.equal(tomiyasu.jfwRating, 6.25);
  assert.equal(tomiyasu.ratingCoverage, 0.481);
  assert.equal(tomiyasu.ratingInputs.gaOnPitch.value, 0);

  assert.equal(maeda.minutes, 80);
  assert.equal(maeda.jfwRating, 6.0);
  assert.equal(maeda.ratingCoverage, 0.513);

  assert.equal(tanaka.minutes, 0);
  assert.equal(tanaka.jfwRating, null);
});
