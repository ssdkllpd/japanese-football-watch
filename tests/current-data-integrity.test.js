const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBackfillHarness } = require('./helpers/backfill-harness');

async function loadedData() {
  const context = buildBackfillHarness();
  await context.window.JFWBackfill.initialLoad;
  return { context, data: context.getData() };
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
