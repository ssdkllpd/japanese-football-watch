'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const { applyMigrations } = require('../scripts/d1/migration-inventory');
const { normalizeFixtureBundle, applyManualCorrections, r2FixtureKey } = require('../scripts/v2/fixture-contract');
const { writeFixtureEnvelope } = require('../scripts/v2/fetch-fixture-vertical-slice');
const { reconcileFixtureRevision } = require('../scripts/v2/reconcile-fixture-revision');
const { createAutomationAdminPlan } = require('../scripts/d1/create-api-football-automation-admin-plan');
const { correctionDefinitions } = require('../scripts/d1/fixture-bundle-importer');

test('automation recheck keeps corrections and complete D1/R2 date feeds', async t => {
  const { publishFixtureFromR2 } = await import('../admin-worker/fixture-ingest.mjs');
  const { publishDateIndexCoverageFromR2 } = await import('../admin-worker/date-index-coverage-ingest.mjs');
  const { handleAdminIngest } = await import('../admin-worker/index.mjs');
  const { executeAdminIngestPlan } = await import('../scripts/d1/request-admin-ingest.mjs');
  const { buildD1DateFeed, buildD1DateIndexesForPublication } = await import('../worker/index.mjs');
  const { dateIndexR2Key, competitionDateIndexR2Key } = await import('../shared/date-index-contract.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-automation-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
  `);
  const raw = {
    fixture: { id: 9001, date: '2026-09-17T06:00:00Z', referee: 'Provider Referee',
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 } },
    league: { id: 39, season: 2026, name: 'Premier League', country: 'England' },
    teams: { home: { id: 40, name: 'Home FC' }, away: { id: 50, name: 'Away FC' } },
    goals: { home: 0, away: 0 }, score: {}, events: [], lineups: [], players: [], statistics: [],
  };
  const observedAt = '2026-09-17T09:00:00.000Z';
  const existing = applyManualCorrections(
    normalizeFixtureBundle(raw, { fetchedAt: observedAt, finalized: true }),
    [{ path: 'fixture.referee', value: 'Verified Referee',
      correctedProviderValue: 'Provider Referee', reason: 'reviewed source',
      sourceUrl: 'https://example.test/fixture/9001', verifiedAt: observedAt },
    { path: 'fixture.score.goals.home', value: 2,
      correctedProviderValue: 0, reason: 'reviewed score',
      sourceUrl: 'https://example.test/fixture/9001', verifiedAt: observedAt }],
  );
  for (const override of Object.values(existing.overrides)) override.reconciledAt = observedAt;
  const objects = new Map([[r2FixtureKey(existing), JSON.stringify(existing)]]);
  const env = {
    ADMIN_INGEST_TOKEN: 'offline-token', FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: {
      async get(key) {
        const rawObject = objects.get(key);
        return rawObject === undefined ? null : { async text() { return rawObject; } };
      },
      async put(key, rawObject) { objects.set(key, rawObject); },
    },
  };
  await publishFixtureFromR2(env, {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_publish',
    fixtureId: existing.fixture.id, competitionId: existing.fixture.competitionId,
    seasonId: existing.fixture.seasonId, reuseStoredCatalog: true,
    correctionDefinitions: {
      schemaVersion: 'd1-fixture-correction-definitions/1', fixtureId: existing.fixture.id,
      definitions: correctionDefinitions(existing),
    },
  });
  const { checkFixtureCorrections } = await import('../scripts/d1/check-automation-fixture-corrections.mjs');
  const guardArgs = {
    url: 'https://offline.example.test', token: 'offline-token',
    fixtureId: existing.fixture.id, competitionId: existing.fixture.competitionId,
    seasonId: existing.fixture.seasonId, date: existing.fixture.dateJst,
    fetchImpl: (url, init) => handleAdminIngest(new Request(url, init), env),
  };
  objects.delete(r2FixtureKey(existing));
  await assert.rejects(() => checkFixtureCorrections(guardArgs), /no canonical R2 fixture/);
  objects.set(r2FixtureKey(existing), JSON.stringify(existing));
  const sameDay = await checkFixtureCorrections(guardArgs);
  assert.equal(sameDay.preservedCorrections, 2);
  assert.equal(sameDay.latestRevision, 1);
  assert.match(sameDay.sameDayPublishedHash, /^[0-9a-f]{64}$/);
  assert.throws(() => reconcileFixtureRevision(existing, normalizeFixtureBundle({
    ...raw, goals: { home: 0, away: 1 },
  }, { fetchedAt: observedAt, finalized: true }), {
    latestD1Revision: sameDay.latestRevision,
    sameDayPublishedHash: sameDay.sameDayPublishedHash,
  }), /changed detail must wait for the next UTC day/);
  // A prior UTC publication day permits the correction recheck in this scenario.
  db.prepare('UPDATE fixture_detail_publish_days SET date_utc = ?')
    .run(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  db.exec(`
    INSERT INTO fixtures(canonical_id,source_id,provider_id,competition_season_id,
      home_team_id,away_team_id,kickoff_utc,date_jst,status_short,status_long,ingestion_state)
    VALUES('af:fixture:9002',1,9002,1,
      (SELECT id FROM teams WHERE provider_id=40),(SELECT id FROM teams WHERE provider_id=50),
      '2026-09-17T12:00:00.000Z','2026-09-17','NS','Not Started','scheduled');
  `);
  const date = '2026-09-17';
  const baseline = await buildD1DateIndexesForPublication(env, date);
  assert.equal(baseline.generic.fixtures[0].score.goals.home, 2);
  objects.set(dateIndexR2Key(date), JSON.stringify(baseline.generic));
  objects.set(competitionDateIndexR2Key('af:competition:39', date), JSON.stringify(baseline.competitions[0]));
  await publishDateIndexCoverageFromR2(env, {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'date_index_coverage_publish',
    date, competitionIds: ['af:competition:39'],
  });
  assert.equal((await buildD1DateFeed(env, date)).fixtures.length, 2);
  assert.equal((await buildD1DateFeed(env, date)).fixtures[0].score.goals.home, 2);

  raw.goals.away = 1;
  const fixtureDir = path.join(root, 'fixtures', '9001');
  writeFixtureEnvelope(fixtureDir, { fixture: raw, quota: {} }, {
    fetchedAt: '2026-09-17T10:00:00.000Z', finalized: true,
  });
  const plan = createAutomationAdminPlan({
    schemaVersion: 'jfw-api-football-automation-plan/1',
    detailFetches: [{ providerFixtureId: 9001, fixtureId: 'af:fixture:9001',
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026' }],
    standingsFetches: [],
  }, root, path.join(root, 'd1'));
  const output = path.join(fixtureDir, 'reconciled.json');
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify(existing));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts/v2/reconcile-fixture-revision.js'),
    path.join(root, 'current.json'), path.join(fixtureDir, 'fixture.json'), output,
    path.join(root, 'd1', plan.fixtures[0].correctionsPath)]);
  const reconciled = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(reconciled.fixture.referee, 'Verified Referee');
  assert.equal(reconciled.overrides['fixture.referee'].status, 'active');
  objects.set(r2FixtureKey(reconciled), JSON.stringify(reconciled));
  const report = await executeAdminIngestPlan(plan, {
    url: 'https://offline.example.test', token: 'offline-token',
    planDirectory: path.join(root, 'd1'),
    fetchImpl: (url, init) => handleAdminIngest(new Request(url, init), env),
  });
  assert.equal(report.passed, true, JSON.stringify(report.results));
  assert.deepEqual(report.results.map(item => item.operation), [
    'fixture_publish', 'date_index_refresh', 'migration_verify',
  ]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM correction_states').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM date_index_coverages').get().n, 1);
  assert.equal((await buildD1DateFeed(env, date)).fixtures.length, 2);
  assert.equal((await buildD1DateFeed(env, date, 'af:competition:39')).fixtures.length, 2);
  assert.equal(JSON.parse(objects.get(dateIndexR2Key(date))).fixtures.length, 2);
  assert.equal(JSON.parse(objects.get(dateIndexR2Key(date))).fixtures[0].score.goals.home, 2);

  // A prior run can publish the fixture but fail before refreshing coverage.
  db.prepare('DELETE FROM date_index_coverages WHERE date_jst = ?').run(date);
  assert.equal(await buildD1DateFeed(env, date), null);
  const retried = await executeAdminIngestPlan(plan, {
    url: 'https://offline.example.test', token: 'offline-token',
    planDirectory: path.join(root, 'd1'),
    fetchImpl: (url, init) => handleAdminIngest(new Request(url, init), env),
  });
  assert.equal(retried.passed, true, JSON.stringify(retried.results));
  assert.equal(retried.results[0].report.imported, false);
  assert.equal((await buildD1DateFeed(env, date)).fixtures.length, 2);

  for (const [providerReferee, status] of [
    ['Verified Referee', 'provider_caught_up'],
    ['Another Referee', 'review_required'],
  ]) {
    const changedProvider = structuredClone(raw);
    changedProvider.fixture.referee = providerReferee;
    const comparison = reconcileFixtureRevision(existing, normalizeFixtureBundle(changedProvider, {
      fetchedAt: '2026-09-17T11:00:00.000Z', finalized: true,
    })).bundle;
    assert.equal(comparison.overrides['fixture.referee'].status, status);
    assert.equal(comparison.fixture.ingestionState,
      status === 'review_required' ? 'needs_review' : 'finalized');
  }

  const { refreshDateIndexesFromD1 } = await import('../admin-worker/date-index-refresh.mjs');
  const incomplete = JSON.parse(objects.get(dateIndexR2Key(date)));
  incomplete.fixtures.push({ ...incomplete.fixtures[0], fixtureId: 'af:fixture:9999' });
  incomplete.fixtures.sort((left, right) => left.kickoffUtc.localeCompare(right.kickoffUtc)
    || left.fixtureId.localeCompare(right.fixtureId));
  objects.set(dateIndexR2Key(date), JSON.stringify(incomplete));
  await assert.rejects(() => checkFixtureCorrections(guardArgs), /fixtures absent from D1/);
  await assert.rejects(() => refreshDateIndexesFromD1(env, {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'date_index_refresh',
    date, fixtureIds: ['af:fixture:9001'],
  }), /full publication is unsafe/);
});
