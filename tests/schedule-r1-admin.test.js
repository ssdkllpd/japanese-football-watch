// Admin Worker schedule update / repair reproduction on real SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drain, setup, baseline, update, jst, r2Ids, r2Payload, feedOrError, pendingRows, fixtureRow,
  dateIndexR2Key, competitionDateIndexR2Key,
} from './helpers/schedule-harness.mjs';

const G = dateIndexR2Key;
const C = (league, date) => competitionDateIndexR2Key(`af:competition:${league}`, date);
const F = id => `af:fixture:${id}`;

test('terminal and interrupted states reach the stored header and both date indexes', async () => {
  for (const status of ['CANC', 'ABD', 'AWD', 'WO', 'SUSP', 'INT']) {
    const ctx = setup([{ id: 9001, league: 39, kickoff: '2026-10-01T10:00:00.000Z' }]);
    await baseline(ctx, ['2026-10-01']);
    assert.equal((await ctx.send(update(9001, 39, '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', 'NS', status))).status, 200);
    assert.equal((await drain(ctx)).status, 200);
    assert.equal(fixtureRow(ctx, 9001).status_short, status);
    assert.equal(r2Payload(ctx, G('2026-10-01')).fixtures[0].status.short, status);
    assert.equal(r2Payload(ctx, C(39, '2026-10-01')).fixtures[0].status.short, status);
    ctx.db.close();
  }
});

test('an old repair cannot delete a newer same-date checkpoint', async () => {
  const ctx = setup([{ id: 9002, league: 39, kickoff: '2026-10-01T10:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-01']);
  assert.equal((await ctx.send(update(9002, 39, '2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z'))).status, 200);
  const firstToken = ctx.db.prepare('SELECT repair_token FROM fixture_schedule_refresh_pending').get().repair_token;
  const prepare = ctx.env.FOOTBALL_DB.prepare.bind(ctx.env.FOOTBALL_DB);
  let armed = true;
  ctx.env.FOOTBALL_DB.prepare = sql => {
    const statement = prepare(sql);
    if (!armed || !/DELETE FROM fixture_schedule_refresh_pending/.test(sql)) return statement;
    armed = false;
    return { bind: (...params) => ({ run: async () => {
      // Another repair completes, then a fresh same-day schedule change arrives.
      ctx.db.exec('DELETE FROM fixture_schedule_refresh_pending');
      assert.equal((await ctx.send(update(9002, 39, '2026-10-01T11:00:00.000Z', '2026-10-01T12:00:00.000Z'))).status, 200);
      return statement.bind(...params).run();
    } }) };
  };
  assert.equal((await ctx.send({operation:'fixture_schedule_repair'})).status, 200);
  assert.equal(pendingRows(ctx).length, 1);
  assert.notEqual(ctx.db.prepare('SELECT repair_token FROM fixture_schedule_refresh_pending').get().repair_token, firstToken);
  assert.equal((await drain(ctx)).status, 200);
  assert.equal(pendingRows(ctx).length, 0);
  assert.equal(r2Payload(ctx, G('2026-10-01')).fixtures[0].kickoffUtc, '2026-10-01T12:00:00.000Z');
  ctx.db.close();
});

test('S01 same JST date time change: D1 feed and R2 payload get the new kickoff and order', async () => {
  const ctx = setup([
    { id: 1001, league: 39, kickoff: '2026-10-03T10:00:00.000Z' },
    { id: 1002, league: 39, kickoff: '2026-10-03T12:00:00.000Z' },
  ]);
  await baseline(ctx, ['2026-10-03']);
  const before = ctx.db.prepare("SELECT fixture_id_digest FROM date_index_coverages WHERE date_jst='2026-10-03'").get().fixture_id_digest;
  assert.equal((await ctx.send(update(1001, 39, '2026-10-03T10:00:00.000Z', '2026-10-03T14:00:00.000Z'))).status, 200);
  assert.equal((await drain(ctx)).status, 200);
  const feed = await feedOrError(ctx, '2026-10-03');
  assert.deepEqual(feed.ids, [F(1002), F(1001)]);
  const r2 = r2Payload(ctx, G('2026-10-03'));
  assert.deepEqual(r2.fixtures.map(f => [f.fixtureId, f.kickoffUtc]),
    [[F(1002), '2026-10-03T12:00:00.000Z'], [F(1001), '2026-10-03T14:00:00.000Z']]);
  assert.deepEqual(r2Payload(ctx, C(39, '2026-10-03')).fixtures.map(f => f.kickoffUtc),
    ['2026-10-03T12:00:00.000Z', '2026-10-03T14:00:00.000Z']);
  const after = ctx.db.prepare("SELECT fixture_id_digest FROM date_index_coverages WHERE date_jst='2026-10-03'").get().fixture_id_digest;
  // Evidence for PR #122 audit gap: coverage digest is ID-only and cannot see time changes.
  assert.equal(after, before);
  assert.deepEqual(pendingRows(ctx), []);
});

test('S02 UTC date changes but JST date does not', async () => {
  // 2026-10-03T16:00Z = JST 10-04 01:00 ; 2026-10-04T01:00Z = JST 10-04 10:00
  const ctx = setup([{ id: 1101, league: 39, kickoff: '2026-10-03T16:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-04']);
  assert.equal((await ctx.send(update(1101, 39, '2026-10-03T16:00:00.000Z', '2026-10-04T01:00:00.000Z'))).status, 200);
  assert.deepEqual(pendingRows(ctx), [{ fixture_id: F(1101), old_date_jst: '2026-10-04', new_date_jst: '2026-10-04' }]);
  assert.equal((await drain(ctx)).status, 200);
  assert.deepEqual(r2Payload(ctx, G('2026-10-04')).fixtures.map(f => f.kickoffUtc), ['2026-10-04T01:00:00.000Z']);
  assert.equal(ctx.objects.has(G('2026-10-03')), false);
});

test('S03 UTC date same, JST date changes (14:00Z -> 15:30Z) moves generic + competition lists', async () => {
  const ctx = setup([
    { id: 1201, league: 39, kickoff: '2026-10-03T14:00:00.000Z' },
    { id: 1202, league: 39, kickoff: '2026-10-03T11:00:00.000Z' },
    { id: 1203, league: 39, kickoff: '2026-10-04T05:00:00.000Z' },
  ]);
  await baseline(ctx, ['2026-10-03', '2026-10-04']);
  assert.equal((await ctx.send(update(1201, 39, '2026-10-03T14:00:00.000Z', '2026-10-03T15:30:00.000Z'))).status, 200);
  assert.equal((await drain(ctx)).status, 200);
  assert.deepEqual(r2Ids(ctx, G('2026-10-03')), [F(1202)]);
  assert.deepEqual(r2Ids(ctx, C(39, '2026-10-03')), [F(1202)]);
  assert.deepEqual(r2Ids(ctx, G('2026-10-04')), [F(1201), F(1203)]);
  assert.deepEqual(r2Ids(ctx, C(39, '2026-10-04')), [F(1201), F(1203)]);
  assert.deepEqual((await feedOrError(ctx, '2026-10-03')).ids, [F(1202)]);
  assert.deepEqual((await feedOrError(ctx, '2026-10-04', 'af:competition:39')).ids, [F(1201), F(1203)]);
});

test('S04 year boundary 2026-12-31T14:59:59Z -> 15:00:00Z moves to 2027-01-01', async () => {
  const ctx = setup([{ id: 1301, league: 140, kickoff: '2026-12-31T14:59:59.000Z' }]);
  await baseline(ctx, ['2026-12-31', '2027-01-01']);
  assert.equal(jst('2026-12-31T15:00:00.000Z'), '2027-01-01');
  assert.equal((await ctx.send(update(1301, 140, '2026-12-31T14:59:59.000Z', '2026-12-31T15:00:00.000Z'))).status, 200);
  assert.equal((await drain(ctx)).status, 200);
  assert.deepEqual(r2Ids(ctx, G('2026-12-31')), []);
  assert.deepEqual(r2Ids(ctx, C(140, '2026-12-31')), []);
  assert.deepEqual(r2Ids(ctx, G('2027-01-01')), [F(1301)]);
  assert.equal(fixtureRow(ctx, 1301).date_jst, '2027-01-01');
});

test('S05 stored kickoff without milliseconds can be rescheduled', async () => {
  // fixtures.kickoff_utc CHECK is GLOB '????-??-??T??:??:??*Z' -> '...:00Z' is a valid stored value.
  const ctx = setup([{ id: 1401, league: 39, kickoff: '2026-10-03T10:00:00Z' }]);
  const r = await ctx.send(update(1401, 39, '2026-10-03T10:00:00Z', '2026-10-05T10:00:00.000Z'));
  // Independent expectation: a valid stored row can be rescheduled.
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('S06 A->B->C and A->B->A converge with no stale list entry and no pending', async () => {
  const ctx = setup([
    { id: 1501, league: 39, kickoff: '2026-10-01T10:00:00.000Z' },
    { id: 1502, league: 39, kickoff: '2026-10-01T12:00:00.000Z' },
  ]);
  const days = ['2026-10-01', '2026-10-03', '2026-10-05'];
  await baseline(ctx, days);
  const k = d => `${d}T10:00:00.000Z`;
  for (const [a, b] of [[days[0], days[1]], [days[1], days[2]], [days[2], days[1]], [days[1], days[0]]]) {
    assert.equal((await ctx.send(update(1501, 39, k(a), k(b)))).status, 200);
    assert.equal((await drain(ctx)).status, 200);
  }
  assert.deepEqual(r2Ids(ctx, G(days[0])), [F(1501), F(1502)]);
  for (const d of days.slice(1)) {
    assert.deepEqual(r2Ids(ctx, G(d)), []);
    assert.deepEqual(r2Ids(ctx, C(39, d)), []);
    assert.deepEqual((await feedOrError(ctx, d)).ids, []);
  }
  assert.deepEqual(pendingRows(ctx), []);
});

test('S07 swap two fixtures between dates; last fixture of a competition leaves its date', async () => {
  const ctx = setup([
    { id: 1601, league: 39, kickoff: '2026-10-10T10:00:00.000Z' },
    { id: 1602, league: 140, kickoff: '2026-10-11T10:00:00.000Z' },
    { id: 1603, league: 140, kickoff: '2026-10-10T18:00:00.000Z' }, // JST 10-11
  ]);
  await baseline(ctx, ['2026-10-10', '2026-10-11']);
  assert.equal((await ctx.send(update(1601, 39, '2026-10-10T10:00:00.000Z', '2026-10-11T09:00:00.000Z'))).status, 200);
  assert.equal((await drain(ctx)).status, 200);
  assert.equal((await ctx.send(update(1602, 140, '2026-10-11T10:00:00.000Z', '2026-10-10T09:00:00.000Z'))).status, 200);
  assert.equal((await drain(ctx)).status, 200);
  assert.deepEqual(r2Ids(ctx, G('2026-10-10')), [F(1602)]);
  assert.deepEqual(r2Ids(ctx, C(39, '2026-10-10')), []);           // emptied, not left stale
  assert.deepEqual(r2Ids(ctx, C(140, '2026-10-10')), [F(1602)]);
  assert.deepEqual(r2Ids(ctx, G('2026-10-11')), [F(1603), F(1601)]); // kickoff order 18:00Z(10-10) < 09:00Z(10-11)
  assert.deepEqual(r2Ids(ctx, C(140, '2026-10-11')), [F(1603)]);
  assert.deepEqual(r2Ids(ctx, C(39, '2026-10-11')), [F(1601)]);
  assert.deepEqual((await feedOrError(ctx, '2026-10-10', 'af:competition:39')).ids ?? [], []);
});

test('S08 R2 put failure at every repair boundary, repeated repair converges', async () => {
  const keys = [G('2026-10-01'), C(39, '2026-10-01'), G('2026-10-02'), C(39, '2026-10-02')];
  for (const failing of keys) {
    const ctx = setup([
      { id: 1701, league: 39, kickoff: '2026-10-01T10:00:00.000Z' },
      { id: 1702, league: 39, kickoff: '2026-10-02T10:00:00.000Z' },
    ]);
    await baseline(ctx, ['2026-10-01', '2026-10-02']);
    assert.equal((await ctx.send(update(1701, 39, '2026-10-01T10:00:00.000Z', '2026-10-02T12:00:00.000Z'))).status, 200);
    ctx.faults.failPutKeys.add(failing);
    assert.equal((await drain(ctx)).status, 422, failing);
    assert.equal(pendingRows(ctx).length, 1);
    // blocked second update while pending
    assert.equal((await ctx.send(update(1702, 39, '2026-10-02T10:00:00.000Z', '2026-10-04T10:00:00.000Z'))).status, 422);
    for (let i = 0; i < 3; i += 1) assert.equal((await drain(ctx)).status, 200);
    assert.deepEqual(r2Ids(ctx, G('2026-10-01')), []);
    assert.deepEqual(r2Ids(ctx, C(39, '2026-10-01')), []);
    assert.deepEqual(r2Ids(ctx, G('2026-10-02')), [F(1702), F(1701)]);
    assert.deepEqual(r2Ids(ctx, C(39, '2026-10-02')), [F(1702), F(1701)]);
    assert.deepEqual(pendingRows(ctx), []);
  }
});

test('S09 crash after all R2 puts and coverage but before pending DELETE: re-run is idempotent', async () => {
  const ctx = setup([{ id: 1801, league: 39, kickoff: '2026-10-01T10:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-01', '2026-10-02']);
  assert.equal((await ctx.send(update(1801, 39, '2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z'))).status, 200);
  const realPrepare = ctx.env.FOOTBALL_DB.prepare.bind(ctx.env.FOOTBALL_DB);
  let armed = true;
  ctx.env.FOOTBALL_DB.prepare = sql => {
    if (armed && /DELETE FROM fixture_schedule_refresh_pending/.test(sql)) { armed = false; throw new Error('injected crash'); }
    return realPrepare(sql);
  };
  assert.equal((await drain(ctx)).status, 422);
  assert.equal(pendingRows(ctx).length, 1);
  assert.equal((await drain(ctx)).status, 200);
  assert.deepEqual(r2Ids(ctx, G('2026-10-02')), [F(1801)]);
  assert.deepEqual(pendingRows(ctx), []);
});

test('S10 [RACE] row changes between the SELECT and the batch: stale conditional update leaves no pending', async () => {
  const ctx = setup([{ id: 1901, league: 39, kickoff: '2026-10-01T10:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-01', '2026-10-05']);
  const db = ctx.env.FOOTBALL_DB;
  const realBatch = db.batch.bind(db);
  db.batch = async statements => {
    // Concurrent writer (e.g. result publication) lands after the stale-check SELECT.
    ctx.db.exec(`INSERT INTO fixture_revisions(fixture_id,revision_no,lifecycle_state,detail_location,content_sha256,created_at,published_at)
      VALUES((SELECT id FROM fixtures WHERE canonical_id='af:fixture:1901'),1,'published','d1','${'b'.repeat(64)}','2026-10-01T13:00:00.000Z','2026-10-01T13:00:00.000Z');
      UPDATE fixtures SET published_revision=(SELECT id FROM fixture_revisions WHERE revision_no=1) WHERE canonical_id='af:fixture:1901';`);
    db.batch = realBatch;
    const results = await realBatch(statements);
    ctx.batchChanges = results.map(r => r.meta.changes);
    return results;
  };
  const r = await ctx.send(update(1901, 39, '2026-10-01T10:00:00.000Z', '2026-10-05T10:00:00.000Z'));
  const evidence = { status: r.status, batchChanges: ctx.batchChanges, row: fixtureRow(ctx, 1901), pending: pendingRows(ctx) };
  const repair = await ctx.send({ operation: 'fixture_schedule_repair' });
  const unrelated = await ctx.send(update(1901, 39, '2026-10-01T10:00:00.000Z', '2026-10-06T10:00:00.000Z'));
  // Independent expectation: an update that changed 0 rows must fail and leave no pending repair.
  assert.equal(pendingRows(ctx).length, 0, 'pending recorded although UPDATE changed 0 rows');
});

test('S11 [PUBLISH DURING PENDING] repair converges after result publication', async () => {
  const ctx = setup([
    { id: 2001, league: 39, kickoff: '2026-10-01T10:00:00.000Z' },
    { id: 2002, league: 39, kickoff: '2026-10-08T10:00:00.000Z' },
  ]);
  await baseline(ctx, ['2026-10-01', '2026-10-02', '2026-10-08', '2026-10-09']);
  assert.equal((await ctx.send(update(2001, 39, '2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z'))).status, 200);
  // Repair did not run (job stopped). Then the fixture's final detail is published
  // (same path the backfill/automation uses sets fixtures.published_revision).
  ctx.db.exec(`INSERT INTO fixture_revisions(fixture_id,revision_no,lifecycle_state,detail_location,content_sha256,created_at,published_at)
    VALUES((SELECT id FROM fixtures WHERE canonical_id='af:fixture:2001'),1,'published','d1','${'c'.repeat(64)}','2026-10-02T13:00:00.000Z','2026-10-02T13:00:00.000Z');
    UPDATE fixtures SET published_revision=(SELECT id FROM fixture_revisions WHERE revision_no=1) WHERE canonical_id='af:fixture:2001';`);
  const results = [];
  for (let i = 0; i < 3; i += 1) results.push((await drain(ctx)).status);
  const other = await ctx.send(update(2002, 39, '2026-10-08T10:00:00.000Z', '2026-10-09T10:00:00.000Z'));
  const oldFeed = await feedOrError(ctx, '2026-10-01');
  const newFeed = await feedOrError(ctx, '2026-10-02');
  // Independent expectation: the date lists converge (fixture only on 10-02) and other fixtures can still be rescheduled.
  assert.deepEqual(r2Ids(ctx, G('2026-10-02')), [F(2001)]);
  assert.equal(other.status, 200);
});

test('S12 two concurrent updates for different fixtures reserve at most one pending slot', async () => {
  const ctx = setup([
    { id: 2101, league: 39, kickoff: '2026-10-01T10:00:00.000Z' },
    { id: 2102, league: 39, kickoff: '2026-10-01T12:00:00.000Z' },
  ]);
  await baseline(ctx, ['2026-10-01', '2026-10-03']);
  // Real D1 calls are network round-trips; model that by yielding on every read.
  const db = ctx.env.FOOTBALL_DB; const realPrepare = db.prepare.bind(db);
  db.prepare = sql => { const st = realPrepare(sql); const wrap = s => ({ bind: (...a) => wrap(s.bind(...a)),
    first: async (...a) => { await new Promise(r => setTimeout(r, 5)); return s.first(...a); },
    all: async () => { await new Promise(r => setTimeout(r, 5)); return s.all(); }, run: () => s.run(), statement: s.statement, params: s.params, _inner: s });
    return wrap(st); };
  const realBatch = db.batch.bind(db);
  db.batch = statements => realBatch(statements.map(s => s._inner || s));
  const [a, b] = await Promise.all([
    ctx.send(update(2101, 39, '2026-10-01T10:00:00.000Z', '2026-10-03T10:00:00.000Z')),
    ctx.send(update(2102, 39, '2026-10-01T12:00:00.000Z', '2026-10-03T12:00:00.000Z')),
  ]);
  const pend = pendingRows(ctx);
  db.prepare = realPrepare; db.batch = realBatch;
  let drained = 0;
  while ((await ctx.send({ operation: 'fixture_schedule_repair' })).body.report?.repaired) drained += 1;
  assert.equal(pend.length,1);
  assert.equal([a,b].filter(result=>result.status===200).length,1);
  assert.equal(drained,2,'the winning fixture has two date repairs');
  assert.equal(r2Ids(ctx, G('2026-10-01')).length, 1);
  // Exactly one concurrent update may reserve the repair slot.: "A second change is refused until that repair is complete."
  assert.ok(pend.length <= 1, `design claim violated: ${pend.length} pending rows`);
});

test('S13 NS -> PST keeps last confirmed kickoff/date; PST -> NS moves to new date', async () => {
  const ctx = setup([{ id: 2201, league: 39, kickoff: '2026-10-01T10:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-01', '2026-11-20']);
  assert.equal((await ctx.send(update(2201, 39, '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', 'NS', 'PST'))).status, 200);
  assert.equal((await drain(ctx)).status, 200);
  const f = (await feedOrError(ctx, '2026-10-01')).feed.fixtures[0];
  assert.equal(f.status.short, 'PST');
  assert.equal(r2Payload(ctx, G('2026-10-01')).fixtures[0].status.short, 'PST');
  assert.equal((await ctx.send(update(2201, 39, '2026-10-01T10:00:00.000Z', '2026-11-20T15:00:00.000Z', 'PST', 'NS'))).status, 200);
  assert.equal((await drain(ctx)).status, 200);
  assert.deepEqual(r2Ids(ctx, G('2026-10-01')), []);
  assert.deepEqual(r2Ids(ctx, G('2026-11-21')), [F(2201)]); // 15:00Z -> JST 11-21
  assert.deepEqual((await feedOrError(ctx, '2026-11-21')).ids, [F(2201)]);
});

test('S14 stale plan (provider changed twice) is refused with no side effects', async () => {
  const ctx = setup([{ id: 2301, league: 39, kickoff: '2026-10-01T10:00:00.000Z' }]);
  await baseline(ctx, ['2026-10-01']);
  const r = await ctx.send(update(2301, 39, '2026-10-01T09:00:00.000Z', '2026-10-02T10:00:00.000Z'));
  assert.equal(r.status, 422);
  assert.deepEqual(pendingRows(ctx), []);
  assert.equal(fixtureRow(ctx, 2301).kickoff_utc, '2026-10-01T10:00:00.000Z');
});
