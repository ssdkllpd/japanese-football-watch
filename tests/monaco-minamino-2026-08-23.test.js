'use strict';

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
    order: ['すべて', 'リーグ・アン'], scope: 'すべて', metric: 'goals', metrics: { goals: '得点' },
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
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-merge.js'), 'utf8'), context, { filename: 'backfill-merge.js' });
  const source = fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'backfill-loader.js' });
  return context;
}

test('Monaco completed fixture and Minamino squad absence load through runtime without a fake rating', async () => {
  const manifest = readJson('data/2026-27/backfill/index.json');
  const apiManifest = readJson('config/api-football-existing-results.json');
  assert.equal(manifest.fragments.at(-1), 'latest-2026-08-23-12.json');
  assert.ok(apiManifest.fixtures.some(fixture => fixture.matchId === 'uecl-2026-08-20-gornik-monaco'));
  assert.ok(apiManifest.fixtureDiscoveryGroups.some(group => group.key === 'monaco' && group.matchIds.includes('uecl-2026-08-20-gornik-monaco')));
  assert.deepEqual(apiManifest.playerAliases['南野拓実'], ['Takumi Minamino', 'T. Minamino']);

  const context = buildHarness();
  await context.window.JFWBackfill.applyCurrentBackfill();
  const merged = context.D;

  const match = merged.matches.find(item => item.matchId === 'uecl-2026-08-20-gornik-monaco');
  assert.ok(match, 'Monaco completed fixture must load through runtime backfill');
  assert.equal(match.match, 'Gornik Zabrze 2-3 AS Monaco');
  assert.equal(match.status, 'verified');

  const minamino = merged.players.find(player => player.name === '南野拓実');
  assert.ok(minamino, 'Minamino must exist in integrated player data');
  assert.equal(minamino.club, 'AS Monaco');
  assert.equal(minamino.league, 'リーグ・アン');
  assert.equal(minamino.squadNumber, 18);

  const record = merged.playerMatchStats.find(item => item.recordId === 'r-minamino-gornik-monaco-20260820');
  assert.ok(record, 'Minamino absence record must load through runtime backfill');
  assert.equal(record.appearance, 'absent_not_in_squad');
  assert.equal(record.minutes, 0);
  assert.equal(record.start, false);
  assert.equal(record.bench, false);
  assert.equal(record.jfwRating, null);
  assert.equal(record.priorityUpdate, false);
});
