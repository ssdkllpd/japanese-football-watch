'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function makeElement() {
  return {
    id: '',
    hidden: false,
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: {},
    firstChild: null,
    setAttribute() {},
    remove() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild() {},
    insertBefore() {},
    insertAdjacentElement() {},
  };
}

function createRuntimeContext(root, season, data, seasons) {
  const main = makeElement();
  const wrap = makeElement();
  const body = makeElement();
  const elements = new Map();
  const context = {
    console: { log() {}, warn() {}, error() {} },
    window: {},
    document: {
      body,
      getElementById(id) { return elements.get(id) || null; },
      querySelector(selector) {
        if (selector === 'main') return main;
        if (selector === '.wrap') return wrap;
        if (selector === 'script[data-jfw-match-detail]') return makeElement();
        return null;
      },
      createElement() {
        const element = makeElement();
        const originalRemove = element.remove;
        element.remove = function remove() {
          if (element.id) elements.delete(element.id);
          originalRemove.call(element);
        };
        return element;
      },
    },
    D: data,
    seasonManifest: seasons,
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
    playerRef(p) { return p.playerId || p.name; },
    playerByRef(ref) { return context.D.players.find(p => p.playerId === ref || p.name === ref); },
    roundNo() { return null; },
    fmt(v) { return v == null ? '—' : String(v); },
    E(v) { return String(v ?? ''); },
    $() { return makeElement(); },
    R: {
      updated: makeElement(), leagueBtns: makeElement(), players: makeElement(), scopeBtns: makeElement(),
      metricBtns: makeElement(), statRank: makeElement(), playerDetail: makeElement(), clubDetail: makeElement(),
    },
    order: ['すべて','プレミアリーグ','チャンピオンシップ','ブンデスリーガ','ラ・リーガ','リーグ・アン','セリエA','エールディヴィジ','ベルギー','ポルトガル','スコットランド'],
    scope: 'すべて', metric: 'goals', metrics: { goals: '得点', assists: 'アシスト' }, attLeague: 'すべて',
    page: 'home', activePlayer: null, activeClub: null, clubRoundFrom: null, clubRoundTo: null,
    clearDetailParams() {}, showPage() {}, lastPage: 'home', setTimeout, clearTimeout,
    fetch: async url => {
      const clean = String(url).replace(/[?&]v=\d+$/, '').replace(/^\.\//, '');
      const filePath = path.join(root, clean);
      if (!fs.existsSync(filePath)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => readJson(filePath) };
    },
  };
  context.window = context;
  wrap.insertBefore = element => { if (element?.id) elements.set(element.id, element); };
  body.insertBefore = wrap.insertBefore;
  return context;
}

async function loadIntegratedSeasonData(root, season) {
  const seasons = readJson(path.join(root, 'seasons.json'));
  const row = (seasons.seasons || []).find(item => String(item.id) === String(season));
  if (!row) throw new Error(`season not found in seasons.json: ${season}`);
  const data = readJson(path.join(root, row.data));
  const context = createRuntimeContext(root, season, data, seasons);
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'backfill-loader.js'), 'utf8'), context, { filename: 'backfill-loader.js' });
  await context.window.JFWBackfill.boot();
  if (context.D?._dataIntegrity?.blocked) {
    throw new Error(`runtime data merge blocked: ${context.D._dataIntegrity.detail || context.D._dataIntegrity.reason}`);
  }
  return JSON.parse(JSON.stringify(context.D));
}

module.exports = { loadIntegratedSeasonData };
