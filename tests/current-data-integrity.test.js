const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRuntimeContext } = require('../scripts/shared/runtime-data-loader');

const ROOT = path.join(__dirname, '..');

function json(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function textKey(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function buildHarness() {
  const seasons = json('seasons.json');
  const season = seasons.seasons.find(s => s.id === seasons.current);
  assert.ok(season, 'current season must resolve from seasons.json');
  const data = json(season.data);
  const context = createRuntimeContext(ROOT, seasons.current, data, seasons);
  context.console = console;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backfill-loader.js'), 'utf8'), context, { filename: 'backfill-loader.js' });
  return context;
}

async function loadedData() {
  const context = buildHarness();
  await context.window.JFWBackfill.applyCurrentBackfill();
  return { context, data: context.D };
}

function registryIndexes(registry) {
  const byId = new Map();
  const byName = new Map();
  const byProvider = new Map();
  for (const row of registry.players || []) {
    byId.set(String(row.playerId), row);
    for (const name of [row.name, ...(row.aliases || [])].map(textKey).filter(Boolean)) byName.set(name, row);
    const providerId = row?.providerIds?.apiFootball?.player;
    if (providerId !== null && providerId !== undefined) byProvider.set(String(providerId), row);
  }
  return { byId, byName, byProvider };
}

function registryEntryFor(value, indexes) {
  if (!value) return null;
  if (value.playerId && indexes.byId.has(String(value.playerId))) return indexes.byId.get(String(value.playerId));
  const providerId = value?.providerIds?.apiFootball?.player ?? value?.apiFootballPlayerId ?? value?.providerPlayerId;
  if (providerId !== null && providerId !== undefined && indexes.byProvider.has(String(providerId))) {
    return indexes.byProvider.get(String(providerId));
  }
  const name = textKey(value.name || value.playerName || value.player);
  return name ? (indexes.byName.get(name) || null) : null;
}

test('current season player identities and memberships satisfy tracking invariants', async () => {
  const { data } = await loadedData();
  const ids = data.players.map(p => p.playerId);
  assert.equal(new Set(ids).size, ids.length, 'playerId must be unique');

  for (const p of data.players) {
    assert.ok(p.playerId, `${p.name}: playerId missing`);
    assert.ok(['active', 'out_of_scope', 'unattached'].includes(p.trackingStatus), `${p.name}: invalid trackingStatus`);
    assert.ok(Array.isArray(p.membershipHistory), `${p.name}: membershipHistory missing`);
    assert.ok(p.membershipHistory.filter(m => !m.to).length <= 1, `${p.name}: multiple open memberships`);
    assert.equal(p.rankingEligible, true, `${p.name}: tracked-season ranking eligibility unexpectedly lost`);
    assert.ok(p.seasonStats && typeof p.seasonStats === 'object', `${p.name}: seasonStats missing`);
    assert.ok(p.competitionStats && typeof p.competitionStats === 'object', `${p.name}: competitionStats missing`);
    assert.ok(p.clubStats && typeof p.clubStats === 'object', `${p.name}: clubStats missing`);
    assert.ok(p.clubCompetitionStats && typeof p.clubCompetitionStats === 'object', `${p.name}: clubCompetitionStats missing`);
    if (p.trackingStatus !== 'active' && p.club) {
      assert.equal(p.clubStats[p.club], undefined, `${p.name}: out-of-scope destination must not receive tracked club stats`);
    }
  }
});

test('current-season base and overlay identities all resolve through player registry', () => {
  const seasons = json('seasons.json');
  const season = seasons.seasons.find(s => s.id === seasons.current);
  assert.ok(season, 'current season must resolve from seasons.json');
  const registry = json('config/player-registry.json');
  const indexes = registryIndexes(registry);
  const base = json(season.data);
  const manifestRel = `data/${seasons.current}/backfill/index.json`;
  const manifest = json(manifestRel);
  const backfillDir = path.dirname(manifestRel);

  for (const player of base.players || []) {
    assert.ok(registryEntryFor(player, indexes), `base player registry missing: ${player.name || player.playerId}`);
  }

  const identityCollections = ['playerUpdates', 'playerMatchStats', 'gaResultsAdd', 'gaResultsRemove'];
  for (const fragmentName of manifest.fragments || []) {
    const fragment = json(path.join(backfillDir, fragmentName));
    for (const key of identityCollections) {
      for (const row of fragment[key] || []) {
        const label = row.name || row.playerName || row.player || row.playerId || row.apiFootballPlayerId || row.providerPlayerId || '(identity missing)';
        assert.ok(
          registryEntryFor(row, indexes),
          `${fragmentName} ${key}: player registry missing: ${label}`
        );
      }
    }
  }
});

test('current playerMatchStats preserve player, match, club and competition provenance', async () => {
  const { data } = await loadedData();
  const players = new Map(data.players.map(p => [p.playerId, p]));
  const matchIds = new Set((data.matches || []).map(m => m.matchId).filter(Boolean));

  for (const r of data.playerMatchStats || []) {
    assert.ok(r.playerId, `${r.recordId || r.matchId}: playerId missing`);
    assert.ok(players.has(r.playerId), `${r.recordId || r.matchId}: unknown playerId ${r.playerId}`);
    assert.ok(r.matchId, `${r.recordId || r.playerName}: matchId missing`);
    assert.ok(matchIds.has(r.matchId), `${r.recordId || r.playerName}: matchId not found in matches`);
    assert.ok(r.club, `${r.recordId || r.playerName}: club-at-match missing`);
    assert.ok(r.competition, `${r.recordId || r.playerName}: competition missing`);
  }
});

test('verified match G/A are reflected in matching club and season aggregates when aggregate fields are known', async () => {
  const { data } = await loadedData();
  const players = new Map(data.players.map(p => [p.playerId, p]));

  for (const r of data.playerMatchStats || []) {
    const p = players.get(r.playerId);
    if (!p || r.trackedAtMatch === false) continue;
    for (const field of ['goals', 'assists']) {
      const input = r.ratingInputs?.[field];
      if (input?.state !== 'value' || Number(input.value) <= 0) continue;
      const clubValue = p.clubStats?.[r.club]?.[field];
      const seasonValue = p.seasonStats?.[field];
      if (clubValue != null) assert.ok(Number(clubValue) >= Number(input.value), `${p.name}: ${field} missing from ${r.club} aggregate`);
      if (seasonValue != null) assert.ok(Number(seasonValue) >= Number(input.value), `${p.name}: ${field} missing from season aggregate`);
    }
  }
});

test('後藤啓介のMotherwell戦ゴールは試合事実から全ての個人成績集計へ反映される', async () => {
  const { data } = await loadedData();
  const player = data.players.find(p => p.name === '後藤啓介');
  assert.ok(player, '後藤啓介の選手レコードが必要');

  const record = (data.playerMatchStats || []).find(r =>
    r.playerId === player.playerId &&
    r.matchId === 'uecl-2026-08-20-motherwell-freiburg'
  );
  assert.ok(record, 'Motherwell戦のplayerMatchStatsが必要');
  assert.equal(record.club, 'フライブルク');
  assert.equal(record.competition, 'UEFA Conference League');
  assert.equal(record.ratingInputs?.goals?.state, 'value');
  assert.equal(record.ratingInputs?.goals?.value, 1);

  assert.equal(player.seasonStats?.goals, 1);
  assert.equal(player.competitionStats?.['UEFA Conference League']?.goals, 1);
  assert.equal(player.clubStats?.['フライブルク']?.goals, 1);
  assert.equal(
    player.clubCompetitionStats?.['フライブルク']?.['UEFA Conference League']?.goals,
    1
  );
});

test('J1 is not an active tracking league or tracked-club source', async () => {
  const { context, data } = await loadedData();
  assert.equal(context.window.JFWTracking.isTrackedLeague('J1'), false);
  const activeJ1 = data.players.filter(p => p.trackingStatus === 'active' && p.league === 'J1');
  assert.equal(activeJ1.length, 0);
});

test('伊東純也のシーズン通算アシストはbaselineと試合明細を二重計上せず2で固定される', async () => {
  const { data } = await loadedData();
  const player = data.players.find(p => p.name === '伊東純也');
  assert.ok(player, '伊東純也の選手レコードが必要');
  assert.equal(player.seasonStats?.assists, 2);
  assert.equal(player.competitionStats?.['ベルギー']?.assists, 2);
  assert.equal(player.clubStats?.['KRCヘンク']?.assists, 2);
});
