const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

function buildHarness({ player, fragments }) {
  const context = {
    console,
    window: {},
    document: {
      body: makeElement(),
      querySelector() { return null; },
      createElement() { return makeElement(); }
    },
    D: {
      updated: '2026-08-10 10:00 JST',
      players: [player],
      matches: [],
      topMatches: [],
      playerMatchStats: [],
      gaResults: []
    },
    selectedSeason: '2026-27',
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
    R: { updated: makeElement(), leagueBtns: makeElement(), players: makeElement(), scopeBtns: makeElement(), metricBtns: makeElement(), statRank: makeElement(), playerDetail: makeElement(), clubDetail: makeElement() },
    order: ['すべて', 'プレミアリーグ', 'ブンデスリーガ'],
    scope: 'すべて',
    metric: 'goals',
    metrics: { goals: '得点' },
    attLeague: 'すべて',
    page: 'home',
    activePlayer: null,
    activeClub: null,
    clubRoundFrom: null,
    clubRoundTo: null,
    clearDetailParams() {},
    showPage() {},
    lastPage: 'home',
    fetch: async url => {
      if (String(url).includes('index.json')) return { ok: true, json: async () => ({ fragments: fragments.map((_, i) => `${i}.json`) }) };
      const match = String(url).match(/\/(\d+)\.json/);
      const index = match ? Number(match[1]) : -1;
      if (index >= 0) return { ok: true, json: async () => fragments[index] };
      return { ok: false, status: 404, json: async () => ({}) };
    },
    setTimeout,
    clearTimeout
  };
  context.window = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'backfill-loader.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'backfill-loader.js' });
  return context;
}

async function apply(context) {
  await context.window.JFWBackfill.applyCurrentBackfill();
  return context.D.players[0];
}

test('tracked-to-tracked transfer keeps one player and splits club stats while preserving season total', async () => {
  const player = {
    name: '移籍太郎',
    club: 'Club A',
    league: 'プレミアリーグ',
    stats: { apps: 2, starts: 2, minutes: 180, goals: 2, assists: 1 }
  };
  const fragments = [
    {
      updated: '2026-08-20 12:00 JST',
      playerUpdates: [{
        name: '移籍太郎',
        club: 'Club B',
        league: 'ブンデスリーガ',
        membershipChangeType: 'transfer',
        transferDate: '2026-08-15'
      }],
      matchUpdates: [{ matchId: 'b-1', league: 'ブンデスリーガ', ko: '2026-08-18 20:00', match: 'Club B 1-0 X', addIfMissing: true }],
      playerMatchStats: [{
        recordId: 'b-1-p', matchId: 'b-1', player: '移籍太郎', club: 'Club B', league: 'ブンデスリーガ', appearance: true, start: true,
        values: { minutes: 90, goals: 1, assists: 0 }, missingFields: []
      }]
    }
  ];
  const context = buildHarness({ player, fragments });
  const p = await apply(context);

  assert.equal(context.D.players.length, 1);
  assert.match(p.playerId, /^jp-/);
  assert.equal(p.membershipHistory.length, 2);
  assert.equal(p.membershipHistory[0].club, 'Club A');
  assert.equal(p.membershipHistory[0].to, '2026-08-15');
  assert.equal(p.membershipHistory[1].club, 'Club B');
  assert.equal(p.trackingStatus, 'active');
  assert.equal(p.seasonStats.goals, 3);
  assert.equal(p.clubStats['Club A'].goals, 2);
  assert.equal(p.clubStats['Club B'].goals, 1);
  assert.equal(p.competitionStats['プレミアリーグ'].goals, 2);
  assert.equal(p.competitionStats['ブンデスリーガ'].goals, 1);
});

test('tracked-to-out-of-scope transfer retains player and ranking with frozen tracked stats', async () => {
  const player = {
    name: '海外次郎',
    club: 'Club A',
    league: 'プレミアリーグ',
    stats: { apps: 3, starts: 2, minutes: 220, goals: 2, assists: 1 }
  };
  const fragments = [{
    updated: '2026-08-20 12:00 JST',
    playerUpdates: [{
      name: '海外次郎',
      club: 'Jクラブ',
      league: 'J1',
      membershipChangeType: 'transfer',
      transferDate: '2026-08-16'
    }]
  }];
  const context = buildHarness({ player, fragments });
  const p = await apply(context);

  assert.equal(context.D.players.length, 1);
  assert.equal(p.club, 'Jクラブ');
  assert.equal(p.previousClub, 'Club A');
  assert.equal(p.trackingStatus, 'out_of_scope');
  assert.equal(p.trackingBucket, '無所属・追跡対象外');
  assert.equal(p.rankingEligible, true);
  assert.equal(p.statsTrackingState, 'frozen_out_of_scope');
  assert.equal(p.seasonStats.goals, 2);
  assert.equal(p.clubStats['Club A'].goals, 2);
  assert.equal(p.clubStats['Jクラブ'], undefined);
});

test('membership correction fixes current club without inventing a transfer stint', async () => {
  const player = {
    name: '訂正三郎',
    club: 'Wrong Club',
    league: 'プレミアリーグ',
    stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 }
  };
  const fragments = [{
    updated: '2026-08-20 12:00 JST',
    playerUpdates: [{
      name: '訂正三郎',
      club: 'Correct Club',
      league: 'プレミアリーグ',
      membershipChangeType: 'correction'
    }]
  }];
  const context = buildHarness({ player, fragments });
  const p = await apply(context);

  assert.equal(p.club, 'Correct Club');
  assert.equal(p.membershipHistory.length, 1);
  assert.equal(p.membershipHistory[0].club, 'Correct Club');
  assert.equal(p.membershipCorrections.length, 1);
  assert.equal(p.membershipCorrections[0].fromClub, 'Wrong Club');
});

test('provider id updates merge without deleting ids from another provider', async () => {
  const player = {
    playerId: 'jp-provider-player',
    name: '識別四郎',
    club: 'Club A',
    league: 'プレミアリーグ',
    providerIds: {
      manualSource: { player: 'manual-44' },
      apiFootball: { team: 10 }
    },
    stats: { apps: 0, starts: 0, minutes: 0, goals: 0, assists: 0 }
  };
  const fragments = [{
    updated: '2026-08-21 14:00 JST',
    playerUpdates: [{
      playerId: 'jp-provider-player',
      name: '識別四郎',
      providerIds: {
        apiFootball: { player: 1234 }
      }
    }]
  }];
  const context = buildHarness({ player, fragments });
  const p = await apply(context);

  assert.equal(p.providerIds.manualSource.player, 'manual-44');
  assert.equal(p.providerIds.apiFootball.team, 10);
  assert.equal(p.providerIds.apiFootball.player, 1234);
});
