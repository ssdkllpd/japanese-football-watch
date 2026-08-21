const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
function element() {
  return { hidden: false, textContent: '', innerHTML: '', dataset: {}, style: {}, setAttribute() {}, remove() {}, querySelectorAll() { return []; }, querySelector() { return null; }, appendChild() {}, insertBefore() {}, insertAdjacentElement() {} };
}

function harness() {
  const main = element();
  const wrap = element();
  const body = element();
  const bannerById = new Map();
  const player = { playerId: 'jp-test', name: 'テスト選手', club: 'Club A', league: 'プレミアリーグ', stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 } };
  const context = {
    console: { log() {}, warn() {}, error() {} }, window: {}, D: { updated: 'base', players: [player], matches: [], topMatches: [] },
    seasonManifest: { current: '2026-27' }, selectedSeason: '2026-27', loadSeason: async () => {},
    document: {
      body,
      getElementById(id) { return bannerById.get(id) || null; },
      querySelector(selector) { if (selector === 'main') return main; if (selector === '.wrap') return wrap; if (selector === 'script[data-jfw-match-detail]') return element(); return null; },
      createElement() { const el = element(); el.remove = () => { if (el.id) bannerById.delete(el.id); }; return el; },
    },
    renderAll() {}, renderPlayerDetail() {}, renderClubDetail() {}, renderAttention() {}, renderStats() {}, relevantClubMatches() { return []; }, clubPlayers() { return []; }, clubMatchCard() { return ''; }, pcard() { return ''; }, mcard() { return ''; }, bindEntities() {}, bindWatch() {}, btns() {}, eligible() { return true; }, playerRef(p) { return p.playerId; }, playerByRef() { return player; }, roundNo() { return null; }, fmt(v) { return String(v); }, E(v) { return String(v ?? ''); }, $() { return element(); },
    R: { updated: element(), leagueBtns: element(), players: element(), scopeBtns: element(), metricBtns: element(), statRank: element(), playerDetail: element(), clubDetail: element() },
    order: ['すべて','プレミアリーグ'], scope: 'すべて', metric: 'goals', metrics: { goals: '得点' }, attLeague: 'すべて', page: 'home', activePlayer: null, activeClub: null, clubRoundFrom: null, clubRoundTo: null, clearDetailParams() {}, showPage() {}, lastPage: 'home', setTimeout, clearTimeout,
    fetch: async url => {
      const clean = String(url).replace(/[?&]v=\d+$/, '');
      if (clean === 'config/player-registry.json') return { ok: true, status: 200, json: async () => ({ players: [{ playerId: 'jp-test', name: 'テスト選手', aliases: [], providerIds: {} }] }) };
      if (clean.includes('index.json')) return { ok: true, status: 200, json: async () => ({ fragments: ['missing.json'] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
  wrap.insertBefore = el => { if (el?.id) bannerById.set(el.id, el); };
  body.insertBefore = wrap.insertBefore;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8'), context, { filename: 'backfill-loader.js' });
  return { context, main };
}

test('current-season overlay failure blocks stale base rendering', async () => {
  const { context, main } = harness();
  await context.window.JFWBackfill.boot();
  assert.equal(context.D._dataIntegrity?.blocked, true);
  assert.equal(context.D._dataIntegrity?.reason, 'current_season_overlay_load_failed');
  assert.equal(main.hidden, true);
});
