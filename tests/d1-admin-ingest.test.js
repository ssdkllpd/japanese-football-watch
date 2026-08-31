'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const { correctionDefinitions } = require('../scripts/d1/fixture-bundle-importer');
const { FixtureRepository } = require('../scripts/d1/fixture-repository');
const { compareFixtureBundles } = require('../scripts/d1/fixture-shadow-compare');

const migrations = ['0001_d1_core.sql', '0002_d1_date_index_coverage.sql', '0003_d1_standings_publication.sql']
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'migrations', file), 'utf8'));

function database() {
  const db = new DatabaseSync(':memory:');
  for (const migration of migrations) db.exec(migration);
  db.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, country_name, type)
      VALUES (1, 'af:competition:39', 1, 39, 'Premier League', 'England', 'League');
    INSERT INTO competition_seasons(id, canonical_id, competition_id, product_season_id, provider_season, label, status)
      VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
  `);
  return db;
}

function provenance() {
  return { source: 'api-football', fetchedAt: '2026-08-31T06:00:00.000Z', verification: 'provider', issues: [] };
}

function scope(played, wins, draws, losses, goalsFor, goalsAgainst) {
  return { played, wins, draws, losses, goalsFor, goalsAgainst };
}

function row(rank, providerId, name, points, goalDifference) {
  return {
    rank, team: { id: `af:team:${providerId}`, providerId, name, logo: null }, points, goalDifference,
    form: null, status: null, description: null,
    overall: scope(2, rank === 1 ? 2 : 0, rank === 1 ? 0 : 1, 0, rank === 1 ? 4 : 1, rank === 1 ? 1 : 3),
    home: scope(1, rank === 1 ? 1 : 0, rank === 1 ? 0 : 1, 0, rank === 1 ? 2 : 1, rank === 1 ? 0 : 1),
    away: scope(1, rank === 1 ? 1 : 0, 0, rank === 1 ? 0 : 1, rank === 1 ? 2 : 0, rank === 1 ? 1 : 2),
    updatedAt: '2026-08-31T05:55:00.000Z', provenance: provenance(),
  };
}

function payload() {
  return {
    contractVersion: '2.0.0',
    competition: { id: 'af:competition:39', providerId: 39, name: 'Premier League', country: 'England', logo: null, flag: null },
    season: { id: 'af:season:39:2026', competitionId: 'af:competition:39', providerSeason: 2026, label: '2026' },
    groups: [{ id: 'table', name: 'Table', table: [row(1, 40, 'First FC', 6, 3), row(2, 50, 'Second FC', 1, -2)] }],
    sectionStates: { standings: { presence: 'present' } }, generatedAt: '2026-08-31T06:00:00.000Z', provenance: provenance(),
  };
}

function env(db, artifact = payload()) {
  const key = 'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/standings/latest.json';
  const raw = JSON.stringify(artifact);
  return {
    ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: { async get(requested) { return requested === key ? { async text() { return raw; } } : null; } },
  };
}

function request(body, token = 'test-token') {
  return new Request('https://admin.example/admin/v1/ingest', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function ingestBody() {
  return {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'standings_publish',
    competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
  };
}

function fixturePayload() {
  const observedAt = '2026-08-31T07:00:00.000Z';
  const source = { source: 'api-football', fetchedAt: observedAt, verification: 'provider', issues: [] };
  return {
    contractVersion: '2.1.0', detailAvailability: 'available',
    fixture: {
      id: 'af:fixture:9001', providerId: 9001,
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
      kickoffUtc: '2026-08-31T15:00:00.000Z', dateJst: '2026-09-01',
      productTimeZone: 'Asia/Tokyo', round: 'Regular Season - 1', referee: 'Referee',
      venue: { id: 'af:venue:10', providerId: 10, name: 'Example Stadium', city: 'London' },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 }, ingestionState: 'finalized',
      teams: {
        home: { id: 'af:team:40', providerId: 40, name: 'First FC', logo: null, winner: true },
        away: { id: 'af:team:50', providerId: 50, name: 'Second FC', logo: null, winner: false },
      },
      score: {
        goals: { home: 2, away: 0 }, halftime: { home: 1, away: 0 },
        fulltime: { home: 2, away: 0 }, extratime: { home: null, away: null },
        penalty: { home: null, away: null },
      },
      revision: 1, reconciledAt: observedAt, provenance: source,
    },
    competition: {
      id: 'af:competition:39', providerId: 39, name: 'Premier League', country: 'England',
      logo: null, flag: null,
    },
    season: {
      id: 'af:season:39:2026', competitionId: 'af:competition:39',
      providerSeason: 2026, label: '2026',
    },
    lineups: [{
      teamId: 'af:team:40', formation: '4-3-3',
      coach: { id: 'af:coach:501', providerId: 501, name: 'Coach', photo: null },
      startXI: [{
        id: 'af:player:1001', providerId: 1001, name: 'Player', number: 7,
        position: 'F', grid: '1:1', role: 'starter',
      }],
      substitutes: [], fieldStates: { formation: { presence: 'present' } }, provenance: source,
    }],
    events: [{
      id: 'event:goal:12', type: 'goal', detail: 'Normal Goal', comments: null,
      elapsed: 12, extra: null, teamId: 'af:team:40', playerId: 'af:player:1001',
      relatedPlayerId: null, provenance: source,
    }],
    teamStats: [{
      teamId: 'af:team:40', values: { total_shots: 12, fouls: 0, offsides: 0 }, provenance: source,
    }],
    playerStats: [{
      fixtureId: 'af:fixture:9001', playerId: 'af:player:1001', playerProviderId: 1001,
      playerName: 'Player', playerPhoto: null, teamId: 'af:team:40', position: 'F',
      starter: true, captain: true, values: { minutes: 90, rating: 8.2, goals: 1, assists: 0 },
      fieldStates: { assists: { presence: 'present' } }, fieldIssues: {}, provenance: source,
    }],
    sectionStates: {
      events: { presence: 'present' }, lineups: { presence: 'present' },
      teamStats: { presence: 'present' }, playerStats: { presence: 'present' },
    },
    overrides: {}, fieldIssues: {},
  };
}

function fixtureIngestBody(bundle = fixturePayload()) {
  return {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'fixture_publish',
    fixtureId: bundle.fixture.id, competitionId: bundle.fixture.competitionId,
    seasonId: bundle.fixture.seasonId,
    catalog: {
      productSeasonId: 'jfw:season:2026-27', source: { apiVersion: 'v3' },
      competition: { type: 'League', countryCode: 'GB' },
      season: { status: 'active', startsOn: '2026-08-01', endsOn: '2027-05-31' },
    },
    correctionDefinitions: {
      schemaVersion: 'd1-fixture-correction-definitions/1', fixtureId: bundle.fixture.id,
      definitions: correctionDefinitions(bundle),
    },
  };
}

function fixtureEnv(db, bundle = fixturePayload()) {
  const key = `football/v2/competitions/${bundle.fixture.competitionId}/seasons/${bundle.fixture.seasonId}/fixtures/${bundle.fixture.id}.json`;
  const raw = JSON.stringify(bundle);
  return {
    ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: { async get(requested) { return requested === key ? { async text() { return raw; } } : null; } },
  };
}

test('admin standings ingest reads the canonical R2 object and atomically publishes a D1 snapshot', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const worker = await import('../worker/index.mjs');
  const response = await admin.default.fetch(request(ingestBody()), env(db));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.report.rowCount, 2);
  assert.match(body.report.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 1);
  assert.deepEqual(await worker.buildD1Standings(
    { FOOTBALL_DB: createLocalD1(db) }, 'af:competition:39', 'af:season:39:2026',
  ), payload());
});

test('admin ingest rejects unauthenticated, wrong-scope, and unavailable source requests before publishing', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  let response = await admin.default.fetch(request(ingestBody(), 'wrong-token'), env(db));
  assert.equal(response.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 0);

  const unconfigured = env(db);
  delete unconfigured.ADMIN_INGEST_TOKEN;
  response = await admin.default.fetch(request(ingestBody()), unconfigured);
  assert.equal(response.status, 503);

  response = await admin.default.fetch(new Request('https://admin.example/not-admin', {
    method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify(ingestBody()),
  }), env(db));
  assert.equal(response.status, 404);

  const wrong = payload();
  wrong.competition.id = 'af:competition:140';
  response = await admin.default.fetch(request(ingestBody()), env(db, wrong));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 0);

  const unavailable = env(db);
  unavailable.FOOTBALL_DATA = { async get() { return null; } };
  response = await admin.default.fetch(request(ingestBody()), unavailable);
  assert.equal(response.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 0);
});

test('admin ingest rejects an oversized authenticated request before parsing or writing', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const oversized = new Request('https://admin.example/admin/v1/ingest', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 'jfw-d1-admin-ingest/1', filler: 'x'.repeat(300 * 1024) }),
  });
  const response = await admin.default.fetch(oversized, env(db));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_snapshots').get().count, 0);
});

test('a failed reimport preserves the previously published standings snapshot', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  await admin.default.fetch(request(ingestBody()), env(db));
  const previous = db.prepare('SELECT source_sha256 FROM standings_publications').get().source_sha256;
  const invalid = payload();
  invalid.groups[0].table[1].team.providerId = 40;
  const response = await admin.default.fetch(request(ingestBody()), env(db, invalid));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT source_sha256 FROM standings_publications').get().source_sha256, previous);
});

test('admin fixture ingest publishes one complete revision and is content-idempotent', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const bundle = fixturePayload();
  let response = await admin.default.fetch(request(fixtureIngestBody(bundle)), fixtureEnv(db, bundle));
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.report.imported, true);
  assert.equal(body.report.statementCount + 12 <= 50, true);
  const resolved = await new FixtureRepository(createLocalD1(db)).resolveFixture(bundle.fixture.id);
  assert.equal(resolved.source, 'd1');
  const comparison = compareFixtureBundles(bundle, resolved.bundle);
  assert.equal(comparison.equal, true, JSON.stringify(comparison.differences));

  response = await admin.default.fetch(request(fixtureIngestBody(bundle)), fixtureEnv(db, bundle));
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.report.imported, false);
  assert.equal(body.report.reason, 'already_published');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture_revisions').get().count, 1);
});

test('admin fixture ingest rejects external scope and correction drift before D1 writes', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const bundle = fixturePayload();
  const wrongScope = fixtureIngestBody(bundle);
  wrongScope.competitionId = 'af:competition:140';
  let response = await admin.default.fetch(request(wrongScope), fixtureEnv(db, bundle));
  assert.equal(response.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixtures').get().count, 0);

  const correctionDrift = fixtureIngestBody(bundle);
  correctionDrift.correctionDefinitions.definitions.push({
    correctionKey: 'af:fixture:9001:fixture.score.goals.home',
    fieldPath: 'fixture.score.goals.home', reason: 'invented', sourceUrl: null, verifiedAt: null,
  });
  response = await admin.default.fetch(request(correctionDrift), fixtureEnv(db, bundle));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixtures').get().count, 0);
});

test('failed fixture replacement rolls back lifecycle and public pointer changes', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const original = fixturePayload();
  let response = await admin.default.fetch(request(fixtureIngestBody(original)), fixtureEnv(db, original));
  assert.equal(response.status, 200);
  const publishedBefore = db.prepare(`
    SELECT fixture.published_revision, revision.content_sha256
    FROM fixtures fixture JOIN fixture_revisions revision ON revision.id = fixture.published_revision
  `).get();

  const replacement = fixturePayload();
  replacement.fixture.revision = 2;
  replacement.fixture.reconciledAt = '2026-08-31T08:00:00.000Z';
  replacement.fixture.provenance.fetchedAt = replacement.fixture.reconciledAt;
  replacement.events[0].provenance.fetchedAt = replacement.fixture.reconciledAt;
  replacement.lineups[0].provenance.fetchedAt = replacement.fixture.reconciledAt;
  replacement.playerStats[0].provenance.fetchedAt = replacement.fixture.reconciledAt;
  replacement.teamStats[0].provenance.fetchedAt = replacement.fixture.reconciledAt;
  replacement.fixture.score.goals.home = 3;
  replacement.fixture.score.fulltime.home = 3;

  const failing = fixtureEnv(db, replacement);
  const local = failing.FOOTBALL_DB;
  const batch = local.batch;
  local.batch = statements => batch([...statements,
    local.prepare('INSERT INTO fixture_revisions(fixture_id) VALUES (NULL)')]);
  response = await admin.default.fetch(request(fixtureIngestBody(replacement)), failing);
  assert.equal(response.status, 422);
  const afterFailure = db.prepare(`
    SELECT fixture.published_revision, revision.content_sha256, revision.lifecycle_state
    FROM fixtures fixture JOIN fixture_revisions revision ON revision.id = fixture.published_revision
  `).get();
  assert.deepEqual({ ...afterFailure }, { ...publishedBefore, lifecycle_state: 'published' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture_revisions').get().count, 1);

  response = await admin.default.fetch(
    request(fixtureIngestBody(replacement)), fixtureEnv(db, replacement),
  );
  assert.equal(response.status, 200);
  const revisions = db.prepare(`
    SELECT revision_no, lifecycle_state FROM fixture_revisions ORDER BY revision_no
  `).all();
  assert.deepEqual(revisions.map(value => ({ ...value })), [
    { revision_no: 1, lifecycle_state: 'superseded' },
    { revision_no: 2, lifecycle_state: 'published' },
  ]);
});

test('fixture admin preflight rejects provider identity replacement and cardinality overflow', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  db.exec(`INSERT INTO teams(canonical_id, source_id, provider_id, name)
    VALUES ('af:team:40', 1, 999, 'Conflicting Team')`);
  const bundle = fixturePayload();
  let response = await admin.default.fetch(request(fixtureIngestBody(bundle)), fixtureEnv(db, bundle));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixtures').get().count, 0);

  db.exec(`DELETE FROM teams WHERE canonical_id = 'af:team:40'`);
  const oversized = fixturePayload();
  oversized.events = Array.from({ length: 101 }, (_, index) => ({
    ...oversized.events[0], id: `event:other:${index}`, type: 'other', elapsed: index,
  }));
  response = await admin.default.fetch(request(fixtureIngestBody(oversized)), fixtureEnv(db, oversized));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixtures').get().count, 0);
});

test('fixture integrity assertion rolls back when a detail write silently stores fewer rows', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const bundle = fixturePayload();
  const fixtureEnvironment = fixtureEnv(db, bundle);
  const local = fixtureEnvironment.FOOTBALL_DB;
  const prepare = local.prepare;
  local.prepare = sql => {
    if (!sql.includes('INSERT INTO fixture_events')) return prepare(sql);
    return {
      bind() {
        return { async run() { return { success: true, meta: { changes: 0 } }; } };
      },
    };
  };
  const response = await admin.default.fetch(
    request(fixtureIngestBody(bundle)), fixtureEnvironment,
  );
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixtures').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture_revisions').get().count, 0);
});
