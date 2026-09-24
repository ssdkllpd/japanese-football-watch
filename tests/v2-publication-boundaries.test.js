'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('../scripts/d1/migration-inventory');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const { normalizeFixtureBundle, applyManualCorrections, r2FixtureKey } = require('../scripts/v2/fixture-contract');
const { reconcileFixtureRevision } = require('../scripts/v2/reconcile-fixture-revision');
const { correctionDefinitions } = require('../scripts/d1/fixture-bundle-importer');

const observedAt = '2026-09-17T09:00:00.000Z';
function rawFixture(id, league = 39) {
  return {
    fixture: { id, date: '2026-09-17T06:00:00Z', status: { short: 'FT', long: 'Match Finished', elapsed: 90 } },
    league: { id: league, season: 2026, name: league === 39 ? 'Premier League' : 'Bundesliga',
      country: league === 39 ? 'England' : 'Germany' },
    teams: { home: { id: 40, name: 'Home FC' }, away: { id: 50, name: 'Away FC' } },
    goals: { home: 0, away: 0 }, score: {}, events: [], lineups: [], players: [], statistics: [],
  };
}
const normalize = raw => normalizeFixtureBundle(raw, { fetchedAt: observedAt, finalized: true });
function corrected(bundle, field, previous, value) {
  const result = applyManualCorrections(bundle, [{ path: field, value, correctedProviderValue: previous,
    reason: 'independent source', sourceUrl: 'https://example.test/review', verifiedAt: observedAt }]);
  for (const override of Object.values(result.overrides)) override.reconciledAt = observedAt;
  return result;
}
function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  applyMigrations(db, path.join(__dirname, '..'));
  db.exec(`INSERT INTO provider_sources(id,code,api_version) VALUES(1,'api-football','v3');
    INSERT INTO product_seasons(id,canonical_id,label,starts_on,ends_on)
      VALUES(1,'jfw:season:2026-27','2026-27','2026-07-01','2027-06-30');
    INSERT INTO competitions(id,canonical_id,source_id,provider_id,name,country_name,type)
      VALUES(1,'af:competition:39',1,39,'Premier League','England','League'),
            (2,'af:competition:78',1,78,'Bundesliga','Germany','League');
    INSERT INTO competition_seasons(id,canonical_id,competition_id,product_season_id,provider_season,label,status)
      VALUES(1,'af:season:39:2026',1,1,2026,'2026','active'),
            (2,'af:season:78:2026',2,1,2026,'2026','active');`);
  const objects = new Map();
  const env = { FOOTBALL_DB: createLocalD1(db), FOOTBALL_DATA: {
    async get(key) { const value = objects.get(key); return value === undefined ? null : { text: async () => value }; },
    async put(key, value) { objects.set(key, value); },
  } };
  return { db, objects, env };
}
async function publish(env, objects, bundle) {
  const { publishFixtureFromR2 } = await import('../admin-worker/fixture-ingest.mjs');
  objects.set(r2FixtureKey(bundle), JSON.stringify(bundle));
  return publishFixtureFromR2(env, {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_publish',
    fixtureId: bundle.fixture.id, competitionId: bundle.fixture.competitionId,
    seasonId: bundle.fixture.seasonId, reuseStoredCatalog: true,
    correctionDefinitions: { schemaVersion: 'd1-fixture-correction-definitions/1',
      fixtureId: bundle.fixture.id, definitions: correctionDefinitions(bundle) },
  });
}

test('a correction in one league does not break another league’s date feed', async t => {
  const { env, objects } = setup(t);
  const { buildD1DateFeed, buildD1DateIndexesForPublication } = await import('../worker/index.mjs');
  const { publishDateIndexCoverageFromR2 } = await import('../admin-worker/date-index-coverage-ingest.mjs');
  const { dateIndexR2Key, competitionDateIndexR2Key } = await import('../shared/date-index-contract.mjs');
  await publish(env, objects, corrected(normalize(rawFixture(9001)), 'fixture.score.goals.home', 0, 1));
  await publish(env, objects, normalize(rawFixture(9002, 78)));
  const date = '2026-09-17';
  const indexes = await buildD1DateIndexesForPublication(env, date);
  objects.set(dateIndexR2Key(date), JSON.stringify(indexes.generic));
  for (const index of indexes.competitions) {
    objects.set(competitionDateIndexR2Key(index.competition.id, date), JSON.stringify(index));
  }
  await publishDateIndexCoverageFromR2(env, {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'date_index_coverage_publish', date,
    competitionIds: ['af:competition:39', 'af:competition:78'],
  });
  assert.equal((await buildD1DateFeed(env, date)).fixtures[0].score.goals.home, 1);
  const unrelated = await buildD1DateFeed(env, date, 'af:competition:78');
  assert.deepEqual(unrelated.fixtures.map(fixture => fixture.fixtureId), ['af:fixture:9002']);
});

test('same-day unchanged fixture with nullable provider stats passes canonical guard', async t => {
  const { env, objects } = setup(t);
  const { verifyStoredFixtureCorrections } = await import('../admin-worker/fixture-correction-guard.mjs');
  const raw = rawFixture(9201);
  raw.statistics = [{ team: { id: 40 }, statistics: [{ type: 'Total Shots', value: null }] }];
  const current = normalize(raw);
  await publish(env, objects, current);
  const request = { schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_correction_guard',
    fixtureId: current.fixture.id, competitionId: current.fixture.competitionId,
    seasonId: current.fixture.seasonId, date: current.fixture.dateJst };
  const guard = await verifyStoredFixtureCorrections(env, request);
  assert.match(guard.sameDayCanonicalHash, /^[0-9a-f]{64}$/);
  assert.equal(reconcileFixtureRevision(current, normalize(raw), {
    latestD1Revision: guard.latestRevision, sameDayCanonicalHash: guard.sameDayCanonicalHash,
  }).changed, false);
  const changed = structuredClone(current);
  changed.fixture.score.goals.home = 1;
  objects.set(r2FixtureKey(current), JSON.stringify(changed));
  await assert.rejects(() => verifyStoredFixtureCorrections(env, request), /differs from today/);
});

test('reordered same-player events cannot inherit an indexed correction', () => {
  const raw = rawFixture(9301);
  const goal = { type: 'Goal', detail: 'Normal Goal', time: { elapsed: 10 },
    team: { id: 40 }, player: { id: 1001 }, assist: { id: null } };
  const card = { ...goal, type: 'Card', detail: 'Yellow Card', time: { elapsed: 70 } };
  raw.events = [goal, card];
  const current = corrected(normalize(raw), 'events.0.relatedPlayerId', null, 'af:player:1002');
  assert.equal(reconcileFixtureRevision(current, normalize(raw)).bundle.events[0].relatedPlayerId,
    'af:player:1002');
  raw.events = [card, goal];
  assert.throws(() => reconcileFixtureRevision(current, normalize(raw)), /changed its indexed event/);
});

test('manual publication refuses the day’s used fixture and the daily cap before any R2 write', async () => {
  const { assertManualPublishBudget } = await import('../scripts/d1/check-v2-manual-publish-budget.mjs');
  const dateUtc = new Date().toISOString().slice(0, 10);
  const plan = { schemaVersion: 'jfw-d1-admin-ingest-plan/1',
    fixtures: [{ fixtureId: 'af:fixture:9101' }] };
  const budget = { schemaVersion: 'jfw-d1-admin-ingest-report/1',
    operation: 'fixture_publish_budget', dateUtc, fixtureIds: ['af:fixture:9101'], remaining: 19 };
  assert.throws(() => assertManualPublishBudget(plan, budget), /already published today/);
  assert.throws(() => assertManualPublishBudget(plan, { ...budget, fixtureIds: [], remaining: 0 }), /daily publication cap/);
  assert.deepEqual(assertManualPublishBudget(plan, { ...budget, fixtureIds: [], remaining: 1 }),
    { fixtureCount: 1, remaining: 0 });
  assert.throws(() => assertManualPublishBudget(plan, { ...budget, dateUtc: '2020-01-01' }), /stale/);
});
