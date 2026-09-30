'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const { applyMigrations } = require('../scripts/d1/migration-inventory');
const { writeFixtureEnvelope } = require('../scripts/v2/fetch-fixture-vertical-slice');
const { createAutomationAdminPlan } = require('../scripts/d1/create-api-football-automation-admin-plan');
const { recoveryDates, checkpointFromArtifacts } = require('../scripts/v2/manual-backfill-checkpoint');

test('two changed JST dates rebuild both feeds and recover after a partial R2 failure', async t => {
  const { buildD1DateIndexesForPublication, buildD1DateFeed } = await import('../worker/index.mjs');
  const { publishDateIndexCoverageFromR2 } = await import('../admin-worker/date-index-coverage-ingest.mjs');
  const { dateIndexR2Key, competitionDateIndexR2Key } = await import('../shared/date-index-contract.mjs');
  const { handleAdminIngest } = await import('../admin-worker/index.mjs');
  const { executeAdminIngestPlan } = await import('../scripts/d1/request-admin-ingest.mjs');
  const { repairManualBackfillDates } = await import('../scripts/d1/repair-manual-backfill-dates.mjs');
  const { checkFixtureCorrections } = await import('../scripts/d1/check-automation-fixture-corrections.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-date-relocation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  applyMigrations(db, path.join(__dirname, '..'));
  db.exec(`
    INSERT INTO provider_sources(id,code,api_version) VALUES(1,'api-football','v3');
    INSERT INTO product_seasons(id,canonical_id,label,starts_on,ends_on)
      VALUES(1,'jfw:season:2026-27','2026-27','2026-07-01','2027-06-30');
    INSERT INTO competitions(id,canonical_id,source_id,provider_id,name,country_name,type)
      VALUES(1,'af:competition:88',1,88,'Eredivisie','Netherlands','League');
    INSERT INTO competition_seasons(id,canonical_id,competition_id,product_season_id,provider_season,label,status)
      VALUES(1,'af:season:88:2026',1,1,2026,'2026','active');
    INSERT INTO teams(id,canonical_id,source_id,provider_id,name)
      VALUES(1,'af:team:40',1,40,'Home'),(2,'af:team:50',1,50,'Away');
    INSERT INTO fixtures(canonical_id,source_id,provider_id,competition_season_id,
      home_team_id,away_team_id,kickoff_utc,date_jst,status_short,status_long,ingestion_state)
    VALUES('af:fixture:1552171',1,1552171,1,1,2,'2026-09-19T10:00:00.000Z','2026-09-19',
      'NS','Not Started','scheduled'),
      ('af:fixture:1552173',1,1552173,1,1,2,'2026-09-20T10:00:00.000Z','2026-09-20',
      'NS','Not Started','scheduled');
  `);
  const objects = new Map();
  let failedKey = null;
  const env = {
    ADMIN_INGEST_TOKEN: 'offline-token', FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: {
      async get(key) { const raw = objects.get(key); return raw === undefined ? null : {
        async text() { return raw; },
      }; },
      async put(key, raw) {
        if (key === failedKey) {
          failedKey = null;
          throw new Error('one interrupted R2 publication');
        }
        objects.set(key, raw);
      },
    },
  };
  const dates = ['2026-09-19', '2026-09-20'];
  for (const date of dates) {
    const built = await buildD1DateIndexesForPublication(env, date);
    objects.set(dateIndexR2Key(date), JSON.stringify(built.generic));
    objects.set(competitionDateIndexR2Key('af:competition:88', date),
      JSON.stringify(built.competitions[0]));
    await publishDateIndexCoverageFromR2(env, { schemaVersion: 'jfw-d1-admin-ingest/1',
      operation: 'date_index_coverage_publish', date,
      competitionIds: ['af:competition:88'] });
  }
  const swaps = [
    { id: 1552171, previousDateJst: dates[0], kickoff: '2026-09-20T10:00:00Z' },
    { id: 1552173, previousDateJst: dates[1], kickoff: '2026-09-19T10:00:00Z' },
  ];
  const detailFetches = [];
  for (const swap of swaps) {
    const fixtureId = `af:fixture:${swap.id}`;
    const raw = {
      fixture: { id: swap.id, date: swap.kickoff,
        status: { short: 'FT', long: 'Match Finished', elapsed: 90 } },
      league: { id: 88, season: 2026, name: 'Eredivisie', country: 'Netherlands' },
      teams: { home: { id: 40, name: 'Home' }, away: { id: 50, name: 'Away' } },
      goals: { home: 2, away: 1 }, score: {}, events: [], lineups: [], players: [], statistics: [],
    };
    const directory = path.join(root, 'fixtures', String(swap.id));
    writeFixtureEnvelope(directory, { fixture: raw, quota: {} }, {
      fetchedAt: '2026-09-29T06:00:00.000Z', finalized: true,
    });
    const bundle = JSON.parse(fs.readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
    objects.set(`football/v2/competitions/af:competition:88/seasons/af:season:88:2026/fixtures/${fixtureId}.json`,
      JSON.stringify(bundle));
    detailFetches.push({ providerFixtureId: swap.id, fixtureId, previousDateJst: swap.previousDateJst,
      competitionId: 'af:competition:88', seasonId: 'af:season:88:2026' });
  }
  const plan = createAutomationAdminPlan({ schemaVersion: 'jfw-api-football-automation-plan/1',
    detailFetches, standingsFetches: [] }, root, path.join(root, 'd1'));
  assert.equal(plan.fixtures.every(item => item.expectedPreviousDate && item.preserveCorrections), true);
  assert.deepEqual(plan.dateIndexRefreshes.map(item => item.departedFixtures[0].fixtureId),
    ['af:fixture:1552171', 'af:fixture:1552173']);
  for (const item of detailFetches) {
    const bundle = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', String(item.providerFixtureId),
      'fixture.json'), 'utf8'));
    const report = await checkFixtureCorrections({ url: 'https://offline.example.test',
      token: 'offline-token', fixtureId: item.fixtureId, competitionId: item.competitionId,
      seasonId: item.seasonId, date: bundle.fixture.dateJst,
      previousDate: item.previousDateJst,
      fetchImpl: (url, init) => handleAdminIngest(new Request(url, init), env) });
    assert.equal(report.latestRevision, 0);
    await assert.rejects(() => checkFixtureCorrections({ url: 'https://offline.example.test',
      token: 'offline-token', fixtureId: item.fixtureId, competitionId: item.competitionId,
      seasonId: item.seasonId, date: bundle.fixture.dateJst,
      fetchImpl: (url, init) => handleAdminIngest(new Request(url, init), env) }),
    /changed its stored JST date/);
  }
  const checkpoint = checkpointFromArtifacts({ schemaVersion: 'jfw-api-football-automation-plan/1',
    detailFetches }, root);
  failedKey = dateIndexR2Key('2026-09-20');
  const report = await executeAdminIngestPlan(plan, {
    url: 'https://offline.example.test', token: 'offline-token',
    planDirectory: path.join(root, 'd1'),
    fetchImpl: (url, init) => handleAdminIngest(new Request(url, init), env),
  });
  assert.equal(report.passed, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fixtures WHERE published_revision IS NOT NULL').get().n, 2);
  const pending = recoveryDates(checkpoint, [{ success: true, results: swaps.map(swap => ({
    canonical_id: `af:fixture:${swap.id}`, total: 2,
  })) }]);
  assert.deepEqual(pending, plan.dateIndexRefreshes);
  await repairManualBackfillDates(pending, { url: 'https://offline.example.test',
    token: 'offline-token', fetchImpl: (url, init) => handleAdminIngest(new Request(url, init), env) });
  for (const date of dates) {
    const D1 = await buildD1DateFeed(env, date);
    const R2 = JSON.parse(objects.get(dateIndexR2Key(date)));
    assert.deepEqual(D1.fixtures.map(item => item.fixtureId), R2.fixtures.map(item => item.fixtureId));
    assert.equal(D1.fixtures.length, 1);
    assert.equal((await buildD1DateFeed(env, date, 'af:competition:88')).fixtures.length, 1);
  }
  assert.deepEqual((await buildD1DateFeed(env, dates[0])).fixtures.map(item => item.fixtureId),
    ['af:fixture:1552173']);
  assert.deepEqual((await buildD1DateFeed(env, dates[1])).fixtures.map(item => item.fixtureId),
    ['af:fixture:1552171']);
  await repairManualBackfillDates(pending, { url: 'https://offline.example.test',
    token: 'offline-token', fetchImpl: (url, init) => handleAdminIngest(new Request(url, init), env) });
  // A later one-way move leaves its old date empty. The old competition index
  // must be rewritten as empty rather than retained with a stale fixture.
  db.prepare(`UPDATE fixtures SET kickoff_utc = '2026-09-20T11:00:00.000Z',
    date_jst = '2026-09-20' WHERE canonical_id = 'af:fixture:1552173'`).run();
  const oldDate = { schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'date_index_refresh',
    date: dates[0], fixtureIds: [], departedFixtures: [{
      fixtureId: 'af:fixture:1552173', date: dates[1],
    }] };
  const undeclared = await handleAdminIngest(new Request('https://offline.example.test/admin/v1/ingest', {
    method: 'POST', headers: { authorization: 'Bearer offline-token' },
    body: JSON.stringify({ ...oldDate, departedFixtures: [{
      fixtureId: 'af:fixture:1552171', date: dates[1],
    }] }),
  }), env);
  assert.equal(undeclared.ok, false);
  const oldRequest = () => new Request('https://offline.example.test/admin/v1/ingest', {
    method: 'POST', headers: { authorization: 'Bearer offline-token' },
    body: JSON.stringify(oldDate),
  });
  failedKey = competitionDateIndexR2Key('af:competition:88', dates[0]);
  const interrupted = await handleAdminIngest(oldRequest(), env);
  assert.equal(interrupted.ok, false);
  assert.equal(JSON.parse(objects.get(dateIndexR2Key(dates[0]))).fixtures.length, 0);
  assert.equal(JSON.parse(objects.get(competitionDateIndexR2Key('af:competition:88', dates[0]))).fixtures.length, 1);
  const oldResult = await handleAdminIngest(oldRequest(), env);
  assert.equal(oldResult.ok, true, await oldResult.text());
  assert.equal(JSON.parse(objects.get(dateIndexR2Key(dates[0]))).fixtures.length, 0);
  assert.equal(JSON.parse(objects.get(competitionDateIndexR2Key('af:competition:88', dates[0]))).fixtures.length, 0);
  assert.equal(db.prepare('SELECT fixture_count FROM date_index_coverages WHERE date_jst = ?')
    .get(dates[0]).fixture_count, 0);
});
