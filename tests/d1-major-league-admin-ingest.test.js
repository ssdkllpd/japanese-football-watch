'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const { normalizeFixtureBundle } = require('../scripts/v2/fixture-contract');
const { correctionDefinitions } = require('../scripts/d1/fixture-bundle-importer');
const { applyMigrations } = require('../scripts/d1/migration-inventory');

const root = path.join(__dirname, '..');

function database() {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, root);
  return db;
}

function provenance() {
  return { source: 'api-football', fetchedAt: '2026-09-08T02:15:09.068Z', verification: 'provider', issues: [] };
}

function scope(played, wins, draws, losses, goalsFor, goalsAgainst) {
  return { played, wins, draws, losses, goalsFor, goalsAgainst };
}

function standing(rank, providerId, name) {
  return {
    rank,
    team: { id: `af:team:${providerId}`, providerId, name, logo: null },
    points: rank === 1 ? 3 : 0,
    goalDifference: rank === 1 ? 2 : -2,
    form: null,
    status: 'same',
    description: null,
    overall: scope(1, rank === 1 ? 1 : 0, 0, rank === 1 ? 0 : 1, rank === 1 ? 2 : 0, rank === 1 ? 0 : 2),
    home: scope(1, rank === 1 ? 1 : 0, 0, rank === 1 ? 0 : 1, rank === 1 ? 2 : 0, rank === 1 ? 0 : 2),
    away: scope(0, 0, 0, 0, 0, 0),
    updatedAt: '2026-09-08T02:00:00.000Z',
    provenance: provenance(),
  };
}

function artifact() {
  const home = { id: 'af:team:40', providerId: 40, name: 'Home FC', code: 'HOM', logo: null };
  const away = { id: 'af:team:50', providerId: 50, name: 'Away FC', code: 'AWY', logo: null };
  return {
    schemaVersion: 'jfw-d1-major-league-core-artifact/1',
    source: {
      provider: 'api-football', apiVersion: 'v3', snapshotId: '20260908-021509068Z',
      archiveKey: 'audit/api-football/v3/major-leagues/2026/snapshots/20260908-021509068Z.tar.gz',
      archiveSha256: 'a'.repeat(64), archiveByteSize: 1234,
      observedAt: '2026-09-08T02:15:09.068Z',
    },
    productSeason: {
      id: 'jfw:season:2026-27', label: '2026/27',
      startsOn: '2026-07-01', endsOn: '2027-06-30',
    },
    competition: {
      id: 'af:competition:39', providerId: 39, name: 'Premier League', country: 'England',
      logo: null, flag: null, type: 'League',
    },
    season: {
      id: 'af:season:39:2026', competitionId: 'af:competition:39', providerSeason: 2026,
      label: '2026/27', startsOn: '2026-08-21', endsOn: '2027-05-30', status: 'current',
    },
    teams: [home, away],
    venues: [{ id: 'af:venue:10', providerId: 10, name: 'Example Stadium', city: 'London' }],
    fixtures: [{
      fixtureId: 'af:fixture:9001', providerId: 9001,
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
      kickoffUtc: '2026-09-01T18:00:00.000Z', dateJst: '2026-09-02',
      round: 'Regular Season - 1', referee: null,
      venue: { id: 'af:venue:10', providerId: 10, name: 'Example Stadium', city: 'London' },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
      ingestionState: 'provisional_final',
      teams: {
        home: { id: home.id, providerId: home.providerId, name: home.name, logo: null, winner: true },
        away: { id: away.id, providerId: away.providerId, name: away.name, logo: null, winner: false },
      },
      score: {
        goals: { home: 2, away: 0 }, halftime: { home: 1, away: 0 },
        fulltime: { home: 2, away: 0 }, extratime: { home: null, away: null },
        penalty: { home: null, away: null },
      },
    }],
    standings: {
      contractVersion: '2.0.0',
      competition: {
        id: 'af:competition:39', providerId: 39, name: 'Premier League', country: 'England',
        logo: null, flag: null,
      },
      season: {
        id: 'af:season:39:2026', competitionId: 'af:competition:39', providerSeason: 2026,
        label: '2026',
      },
      groups: [{ id: 'group:1', name: 'Table', table: [
        standing(1, 40, 'Home FC'), standing(2, 50, 'Away FC'),
      ] }],
      sectionStates: { standings: { presence: 'present' } },
      generatedAt: '2026-09-08T02:15:09.068Z', provenance: provenance(),
    },
  };
}

function setup(db, value = artifact()) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  const artifactSha256 = createHash('sha256').update(raw).digest('hex');
  const artifactKey = `migration/api-football/v3/major-leagues/2026/${'a'.repeat(64)}`
    + `/leagues/39/core-${artifactSha256}.json`;
  const objects = new Map([[artifactKey, raw]]);
  const environment = {
    ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: {
      async get(key) {
        const stored = objects.get(key);
        return stored === undefined ? null : { async text() { return stored; } };
      },
    },
  };
  const base = {
    schemaVersion: 'jfw-d1-admin-ingest/1',
    competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
    snapshotId: '20260908-021509068Z', archiveSha256: 'a'.repeat(64),
    artifactKey, artifactSha256,
  };
  return { environment, base, objects };
}

function fixtureMigration(base, objects) {
  const bundle = normalizeFixtureBundle({
    fixture: {
      id: 9001, date: '2026-09-01T18:00:00+00:00', referee: null,
      venue: { id: 10, name: 'Example Stadium', city: 'London' },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
    },
    league: {
      id: 39, name: 'Premier League', country: 'England', logo: null, flag: null,
      season: 2026, round: 'Regular Season - 1',
    },
    teams: {
      home: { id: 40, name: 'Home FC', logo: null, winner: true },
      away: { id: 50, name: 'Away FC', logo: null, winner: false },
    },
    goals: { home: 2, away: 0 },
    score: {
      halftime: { home: 1, away: 0 }, fulltime: { home: 2, away: 0 },
      extratime: { home: null, away: null }, penalty: { home: null, away: null },
    },
    events: [], lineups: [], players: [], statistics: [],
  }, { fetchedAt: '2026-09-08T02:15:09.068Z' });
  const wrapper = {
    schemaVersion: 'jfw-d1-fixture-migration-artifact/1', source: artifact().source, bundle,
  };
  const raw = `${JSON.stringify(wrapper, null, 2)}\n`;
  const artifactSha256 = createHash('sha256').update(raw).digest('hex');
  const artifactKey = `migration/api-football/v3/major-leagues/2026/${base.archiveSha256}`
    + `/fixtures/9001-${artifactSha256}.json`;
  objects.set(artifactKey, raw);
  return {
    ...base,
    operation: 'fixture_migration_publish',
    fixtureId: 'af:fixture:9001', artifactKey, artifactSha256,
    reuseStoredCatalog: true,
    correctionDefinitions: {
      schemaVersion: 'd1-fixture-correction-definitions/1',
      fixtureId: 'af:fixture:9001', definitions: correctionDefinitions(bundle),
    },
  };
}

function digestFixtureIds(ids) {
  return createHash('sha256').update(`${[...ids].sort().join('\n')}\n`).digest('hex');
}

function coverageMigration(base, objects) {
  const fixtureIds = ['af:fixture:9001'];
  const wrapper = {
    schemaVersion: 'jfw-d1-major-league-date-coverage-artifact/1',
    source: artifact().source,
    dates: [{
      date: '2026-09-02', fixtureIds, fixtureIdDigest: digestFixtureIds(fixtureIds),
      competitions: [{
        competitionId: 'af:competition:39', fixtureIds,
        fixtureIdDigest: digestFixtureIds(fixtureIds),
      }],
    }],
  };
  const raw = `${JSON.stringify(wrapper, null, 2)}\n`;
  const artifactSha256 = createHash('sha256').update(raw).digest('hex');
  const artifactKey = `migration/api-football/v3/major-leagues/2026/${base.archiveSha256}`
    + `/date-coverages-${artifactSha256}.json`;
  objects.set(artifactKey, raw);
  return {
    schemaVersion: base.schemaVersion,
    operation: 'major_league_date_coverage_publish',
    snapshotId: base.snapshotId,
    archiveSha256: base.archiveSha256,
    artifactKey,
    artifactSha256,
    date: '2026-09-02',
    competitionIds: ['af:competition:39'],
  };
}

function request(body) {
  return new Request('https://admin.example/admin/v1/ingest', {
    method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('major-league core and standings migration is hash-scoped, complete, and idempotent', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const worker = await import('../worker/index.mjs');
  const { environment, base, objects } = setup(db);

  let response = await admin.default.fetch(request({ ...base, operation: 'major_league_core_publish' }), environment);
  const coreText = await response.text();
  assert.equal(response.status, 200, coreText);
  let result = JSON.parse(coreText);
  assert.deepEqual(result.report.counts, { teams: 2, venues: 1, fixtures: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM competitions').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM competition_seasons').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM teams').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixtures').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture_score_parts').get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM raw_snapshots WHERE retention_class = 'migration-major-league-core'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM record_sources WHERE fact_kind = 'major_league_core_snapshot'").get().count, 1);

  response = await admin.default.fetch(request({ ...base, operation: 'major_league_standings_publish' }), environment);
  assert.equal(response.status, 200);
  result = await response.json();
  assert.equal(result.report.rowCount, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 1);
  assert.deepEqual(await worker.buildD1Standings(
    { FOOTBALL_DB: createLocalD1(db) }, 'af:competition:39', 'af:season:39:2026',
  ), artifact().standings);

  response = await admin.default.fetch(request(fixtureMigration(base, objects)), environment);
  const fixtureText = await response.text();
  assert.equal(response.status, 200, fixtureText);
  result = JSON.parse(fixtureText);
  assert.equal(result.report.operation, 'fixture_migration_publish');
  assert.equal(result.report.imported, true);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM fixtures fixture
    JOIN fixture_revisions revision ON revision.id = fixture.published_revision
    WHERE revision.lifecycle_state = 'published'
  `).get().count, 1);

  response = await admin.default.fetch(request(coverageMigration(base, objects)), environment);
  const coverageText = await response.text();
  assert.equal(response.status, 200, coverageText);
  result = JSON.parse(coverageText);
  assert.equal(result.report.fixtureCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM date_index_coverages').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM competition_date_index_coverages').get().count, 1);
  const genericFeed = await worker.buildD1DateFeed(
    { FOOTBALL_DB: createLocalD1(db) }, '2026-09-02', null,
  );
  assert.deepEqual(genericFeed.fixtures.map(item => item.fixtureId), ['af:fixture:9001']);

  const verification = {
    schemaVersion: base.schemaVersion,
    operation: 'migration_verify',
    snapshotId: base.snapshotId,
    archiveSha256: base.archiveSha256,
    fixedSnapshot: null,
    fixtureIds: ['af:fixture:9001'],
    standings: [{ competitionId: base.competitionId, seasonId: base.seasonId }],
    dateIndexCoverages: [{
      date: '2026-09-02', competitionIds: ['af:competition:39'],
    }],
    expectedTotals: null,
    majorLeagueSeasons: [{
      competitionId: base.competitionId,
      seasonId: base.seasonId,
      startsOn: '2026-08-21',
      endsOn: '2027-05-30',
      teamCount: 2,
      fixtureCount: 1,
      publishedFixtureDetailCount: 1,
      standingsRowCount: 2,
      coreArtifactKey: base.artifactKey,
      coreArtifactSha256: base.artifactSha256,
    }],
  };
  response = await admin.default.fetch(request(verification), environment);
  const verificationText = await response.text();
  assert.equal(response.status, 200, verificationText);
  result = JSON.parse(verificationText);
  assert.equal(result.report.passed, true);
  assert.equal(result.report.majorLeagueSeasons[0].actual.fixtureCount, 1);
  assert.equal(result.report.majorLeagueSeasons[0].actual.scorePartCount, 4);

  response = await admin.default.fetch(request({
    ...verification,
    majorLeagueSeasons: [{ ...verification.majorLeagueSeasons[0], fixtureCount: 2 }],
  }), environment);
  assert.equal(response.status, 409);

  response = await admin.default.fetch(request({ ...base, operation: 'major_league_core_publish' }), environment);
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixtures').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM record_sources WHERE fact_kind = 'major_league_core_snapshot'").get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM date_index_coverages').get().count, 0);
});

test('major-league migration rejects artifact hash drift before any D1 write', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const { environment, base } = setup(db);
  const response = await admin.default.fetch(request({
    ...base, operation: 'major_league_core_publish', artifactSha256: 'b'.repeat(64),
  }), environment);
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.match(body.detail, /content-addressed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM competitions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixtures').get().count, 0);
});
