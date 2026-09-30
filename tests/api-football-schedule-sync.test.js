'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const { applyMigrations } = require('../scripts/d1/migration-inventory');
const { planScheduleSync } = require('../scripts/v2/plan-fixture-schedule-sync');
const policy = require('../config/api-football-automation.json');

test('complete season scan selects only changed unpublished fixtures and holds rich details', async () => {
  const rows = [];
  const data = new Map();
  for (const scope of policy.competitionSeasons) {
    const fixtures = [];
    for (let index = 0; index < 342; index += 1) {
      const id = scope.league * 10000 + index;
      const date = '2026-10-01T10:00:00.000Z';
      rows.push({ fixture_id: `af:fixture:${id}`,
        competition_id: `af:competition:${scope.league}`,
        season_id: `af:season:${scope.league}:2026`, kickoff_utc: date,
        status_short: 'NS', published_revision: index === 1 ? 999 : null, total: 3420 });
      fixtures.push({ fixture: { id, date, status: { short: 'NS' } },
        league: { id: scope.league, season: 2026 } });
    }
    data.set(scope.league, fixtures);
  }
  data.get(39)[0].fixture.date = '2026-10-03T10:00:00Z';
  data.get(39)[1].fixture.date = '2026-10-03T10:00:00Z';
  data.get(39)[2].fixture.status.short = 'PST';
  const client = { async refreshDailyQuota() { return { dailyRemaining: 7000 }; },
    async get(_name, params) { return { data: { response: data.get(params.league), paging: { total: 1 } },
      quota: { dailyRemaining: 6990 } }; } };
  const plan = await planScheduleSync({ client, inventory: [{ results: rows, success: true }] });
  assert.equal(plan.scanned, 3420);
  assert.equal(plan.changes.length, 2);
  assert.equal(plan.held.length, 1);
  assert.deepEqual(plan.changes.map(item => item.fixtureId), ['af:fixture:390000', 'af:fixture:390002']);
  assert.equal(plan.changes[1].newStatus, 'PST');
  assert.equal(plan.changes[1].newKickoffUtc, plan.changes[1].oldKickoffUtc);
  data.get(39).pop();
  await assert.rejects(() => planScheduleSync({ client, inventory: [{ results: rows, success: true }] }),
    /disappeared/);
  data.get(39).push({ fixture: { id: 390341, date: '2026-10-01T10:00:00Z',
    status: { short: 'NS' } }, league: { id: 39, season: 2026 } });
  for (let index = 3; index < 25; index += 1) {
    data.get(39)[index].fixture.date = '2026-10-03T10:00:00Z';
  }
  const oversized = await planScheduleSync({ client, inventory: [{ results: rows, success: true }] });
  assert.equal(oversized.executable, false);
  assert.equal(oversized.changes.length, 24);
});

test('schedule relocation survives interrupted index write, retries, and a second move', async t => {
  const { handleAdminIngest } = await import('../admin-worker/index.mjs');
  const { buildD1DateIndexesForPublication, buildD1DateFeed } = await import('../worker/index.mjs');
  const { publishDateIndexCoverageFromR2 } = await import('../admin-worker/date-index-coverage-ingest.mjs');
  const { dateIndexR2Key, competitionDateIndexR2Key } = await import('../shared/date-index-contract.mjs');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  applyMigrations(db, path.join(__dirname, '..'));
  db.exec(`
    INSERT INTO provider_sources(id,code,api_version) VALUES(1,'api-football','v3');
    INSERT INTO product_seasons(id,canonical_id,label,starts_on,ends_on)
      VALUES(1,'jfw:season:2026-27','2026-27','2026-07-01','2027-06-30');
    INSERT INTO competitions(id,canonical_id,source_id,provider_id,name,country_name,type)
      VALUES(1,'af:competition:39',1,39,'Premier League','England','League');
    INSERT INTO competition_seasons(id,canonical_id,competition_id,product_season_id,provider_season,label,status)
      VALUES(1,'af:season:39:2026',1,1,2026,'2026','active');
    INSERT INTO teams(id,canonical_id,source_id,provider_id,name)
      VALUES(1,'af:team:40',1,40,'Home'),(2,'af:team:50',1,50,'Away');
    INSERT INTO fixtures(canonical_id,source_id,provider_id,competition_season_id,
      home_team_id,away_team_id,kickoff_utc,date_jst,status_short,status_long,ingestion_state)
      VALUES('af:fixture:9001',1,9001,1,1,2,'2026-10-01T10:00:00.000Z',
        '2026-10-01','NS','Not Started','scheduled');
  `);
  const objects = new Map();
  let failDate = null;
  const env = { ADMIN_INGEST_TOKEN: 'test', FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: {
      async get(key) { const value = objects.get(key); return value === undefined ? null
        : { async text() { return value; } }; },
      async put(key, value) {
        if (key === failDate) { failDate = null; throw new Error('interrupted'); }
        objects.set(key, value);
      },
    } };
  for (const date of ['2026-10-01', '2026-10-03', '2026-10-05']) {
    const result = await buildD1DateIndexesForPublication(env, date, ['af:competition:39']);
    objects.set(dateIndexR2Key(date), JSON.stringify(result.generic));
    objects.set(competitionDateIndexR2Key('af:competition:39', date), JSON.stringify(result.competitions[0]));
    await publishDateIndexCoverageFromR2(env, { schemaVersion: 'jfw-d1-admin-ingest/1',
      operation: 'date_index_coverage_publish', date, competitionIds: ['af:competition:39'] });
  }
  const send = async payload => {
    const response = await handleAdminIngest(new Request('https://offline.test/admin/v1/ingest', {
      method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify({
        schemaVersion: 'jfw-d1-admin-ingest/1', ...payload }),
    }), env);
    return { status: response.status, body: await response.json() };
  };
  const update = (oldKickoffUtc, newKickoffUtc, oldStatus = 'NS', newStatus = 'NS') => ({
    operation: 'fixture_schedule_update', fixtureId: 'af:fixture:9001',
    competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
    oldKickoffUtc, newKickoffUtc, oldStatus, newStatus,
  });
  const first = '2026-10-01T10:00:00.000Z';
  const second = '2026-10-03T10:00:00.000Z';
  const third = '2026-10-05T10:00:00.000Z';
  assert.equal((await send(update(first, second))).status, 200);
  assert.equal((await send(update(first, third))).status, 422);
  failDate = dateIndexR2Key('2026-10-03');
  assert.equal((await send({ operation: 'fixture_schedule_repair' })).status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture_schedule_refresh_pending').get().count, 1);
  assert.equal((await send({ operation: 'fixture_schedule_repair' })).status, 200);
  assert.deepEqual((await buildD1DateFeed(env, '2026-10-01')).fixtures, []);
  assert.deepEqual((await buildD1DateFeed(env, '2026-10-03')).fixtures.map(row => row.fixtureId),
    ['af:fixture:9001']);
  assert.equal((await send(update(second, third))).status, 200);
  assert.equal((await send({ operation: 'fixture_schedule_repair' })).status, 200);
  assert.deepEqual((await buildD1DateFeed(env, '2026-10-03')).fixtures, []);
  assert.deepEqual((await buildD1DateFeed(env, '2026-10-05')).fixtures.map(row => row.fixtureId),
    ['af:fixture:9001']);
  assert.equal((await send(update(third, second, 'NS', 'PST'))).status, 200);
  assert.equal((await send({ operation: 'fixture_schedule_repair' })).status, 200);
  assert.equal((await buildD1DateFeed(env, '2026-10-03')).fixtures[0].status.short, 'PST');
  db.exec(`INSERT INTO fixture_revisions(fixture_id,revision_no,lifecycle_state,
    detail_location,content_sha256,created_at,published_at)
    VALUES((SELECT id FROM fixtures WHERE canonical_id='af:fixture:9001'),1,'published',
      'd1','${'a'.repeat(64)}','2026-10-03T11:00:00.000Z','2026-10-03T11:00:00.000Z');
    UPDATE fixtures SET published_revision=(SELECT id FROM fixture_revisions WHERE revision_no=1)
      WHERE canonical_id='af:fixture:9001';`);
  assert.equal((await send(update(second, third, 'PST', 'NS'))).status, 422);
});
