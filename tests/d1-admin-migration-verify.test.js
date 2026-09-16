'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const { applyMigrations } = require('../scripts/d1/migration-inventory');

const root = path.join(__dirname, '..');
const snapshotSha = 'b'.repeat(64);
const fixtureDigest = 'c'.repeat(64);
const sourceSha = 'd'.repeat(64);

function database() {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, root);
  db.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO raw_snapshots(
      id, source_id, r2_key, content_sha256, fetched_at, retention_class, byte_size
    ) VALUES (
      1, 1, 'migration/fixed-snapshots/${snapshotSha}.json', '${snapshotSha}',
      '2026-08-31T00:30:00.000Z', 'migration-fixed-snapshot', 1
    );
    INSERT INTO sync_runs(
      id, run_type, started_at, finished_at, status, requests_used, code_revision
    ) VALUES (
      1, 'fixed_snapshot_import', '2026-08-31T00:30:00.000Z',
      '2026-08-31T00:30:00.000Z', 'completed', 0, '${snapshotSha}'
    );
    INSERT INTO record_sources(
      sync_run_id, raw_snapshot_id, fact_kind, fact_key, observed_at, verification
    ) VALUES (
      1, 1, 'fixed_snapshot', '${snapshotSha}', '2026-08-31T00:30:00.000Z',
      'legacy_unverified'
    );
    INSERT INTO tracked_players(
      jfw_player_id, player_id, crosswalk_state, crosswalk_sync_run_id,
      tracking_status, tracking_started_on
    ) VALUES ('jp-test', NULL, 'unresolved', 1, 'active', '2026-07-01');
    INSERT INTO tracked_player_aggregates(
      jfw_player_id, product_season_id, aggregate_scope, stats_json, source_hash, rebuilt_at
    ) VALUES (
      'jp-test', 1, 'season', '{}', '${sourceSha}', '2026-08-31T00:30:00.000Z'
    );
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, type)
      VALUES (1, 'af:competition:39', 1, 39, 'Premier League', 'League');
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
    INSERT INTO teams(id, canonical_id, source_id, provider_id, name) VALUES
      (1, 'af:team:40', 1, 40, 'Home FC'),
      (2, 'af:team:50', 1, 50, 'Away FC');
    INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id,
      home_team_id, away_team_id, kickoff_utc, date_jst, status_short, ingestion_state
    ) VALUES (
      1, 'af:fixture:9001', 1, 9001, 1, 1, 2,
      '2026-08-21T20:00:00.000Z', '2026-08-22', 'FT', 'finalized'
    );
    INSERT INTO fixture_revisions(
      id, fixture_id, revision_no, lifecycle_state, detail_location,
      content_sha256, created_at, published_at
    ) VALUES (
      1, 1, 1, 'published', 'd1', '${sourceSha}',
      '2026-08-21T22:00:00.000Z', '2026-08-21T22:00:00.000Z'
    );
    UPDATE fixtures SET published_revision = 1 WHERE id = 1;
    INSERT INTO standings_snapshots(
      id, competition_season_id, observed_at, is_final, checksum,
      contract_version, section_presence, provenance_source, provenance_fetched_at,
      provenance_verification, provenance_issues_json
    ) VALUES (
      1, 1, '2026-08-21T22:00:00.000Z', 0, '${sourceSha}',
      '2.0.0', 'present', 'api-football', '2026-08-21T22:00:00.000Z',
      'provider', '[]'
    );
    INSERT INTO standings_publications(
      competition_season_id, snapshot_id, row_count, identity_digest,
      generated_at, source_r2_key, source_sha256
    ) VALUES (
      1, 1, 0, '${fixtureDigest}', '2026-08-21T22:00:00.000Z',
      'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/standings/latest.json',
      '${sourceSha}'
    );
    INSERT INTO date_index_coverages(
      date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
    ) VALUES (
      '2026-08-22', 1, '${fixtureDigest}', '2026-08-21T22:00:00.000Z',
      'football/v2/indexes/date-jst/2026-08-22.json', '${sourceSha}'
    );
    INSERT INTO competition_date_index_coverages(
      competition_id, date_jst, fixture_count, fixture_id_digest,
      generated_at, source_r2_key, source_sha256
    ) VALUES (
      1, '2026-08-22', 1, '${fixtureDigest}', '2026-08-21T22:00:00.000Z',
      'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
      '${sourceSha}'
    );
  `);
  return db;
}

function body() {
  return {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'migration_verify',
    fixedSnapshot: {
      artifactSha256: snapshotSha, productSeasonId: 'jfw:season:2026-27',
    },
    fixtureIds: ['af:fixture:9001'],
    fixtureExpectations: [{
      fixtureId: 'af:fixture:9001', revisionNo: 1, contentSha256: sourceSha,
    }],
    standings: [{ competitionId: 'af:competition:39', seasonId: 'af:season:39:2026' }],
    dateIndexCoverages: [{ date: '2026-08-22', competitionIds: ['af:competition:39'] }],
    expectedTotals: {
      fixedSnapshots: 1, publishedFixtures: 1, publishedStandings: 1,
      dateIndexCoverages: 1, competitionDateIndexCoverages: 1,
    },
  };
}

function request(payload) {
  return new Request('https://admin.example/admin/v1/ingest', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function environment(db) {
  return { ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: createLocalD1(db) };
}

test('admin migration verification proves every externally declared publication scope', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const response = await admin.default.fetch(request(body()), environment(db));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.report, {
    schemaVersion: 'jfw-d1-admin-ingest-report/1', operation: 'migration_verify',
    passed: true,
    fixedSnapshot: {
      expected: true, artifactSha256: snapshotSha,
      productSeasonId: 'jfw:season:2026-27', verified: true,
    },
    fixtureCount: 1, standingsCount: 1, dateIndexCoverageCount: 1,
    competitionDateCoverageCount: 1,
    missingFixtureIds: [], fixtureRevisionMismatches: [],
    missingStandings: [], missingDateIndexes: [],
    competitionScopeMismatches: [],
    expectedTotals: {
      fixedSnapshots: 1, publishedFixtures: 1, publishedStandings: 1,
      dateIndexCoverages: 1, competitionDateIndexCoverages: 1,
    },
    actualTotals: {
      fixedSnapshots: 1, publishedFixtures: 1, publishedStandings: 1,
      dateIndexCoverages: 1, competitionDateIndexCoverages: 1,
    },
    totalMismatches: [], productionReady: false,
  });
});

test('admin migration verification fails closed for missing fixture or mismatched competition coverage', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  db.exec('UPDATE fixtures SET published_revision = NULL WHERE id = 1');
  let response = await admin.default.fetch(request(body()), environment(db));
  assert.equal(response.status, 409);
  let result = await response.json();
  assert.deepEqual(result.report.missingFixtureIds, ['af:fixture:9001']);

  db.exec(`
    UPDATE fixtures SET published_revision = 1 WHERE id = 1;
    DELETE FROM competition_date_index_coverages WHERE date_jst = '2026-08-22';
  `);
  response = await admin.default.fetch(request(body()), environment(db));
  assert.equal(response.status, 409);
  result = await response.json();
  assert.deepEqual(result.report.competitionScopeMismatches, [{
    date: '2026-08-22', expected: ['af:competition:39'], actual: [],
  }]);
});

test('admin migration verification independently rejects revision and content drift', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  db.exec(`UPDATE fixture_revisions SET revision_no = 2, content_sha256 = '${'e'.repeat(64)}' WHERE id = 1`);
  const response = await admin.default.fetch(request(body()), environment(db));
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.deepEqual(result.report.missingFixtureIds, []);
  assert.deepEqual(result.report.fixtureRevisionMismatches, [{
    fixtureId: 'af:fixture:9001',
    expected: { revisionNo: 1, contentSha256: sourceSha },
    actual: { revisionNo: 2, contentSha256: 'e'.repeat(64) },
  }]);
});

test('admin migration verification rejects duplicate and impossible scopes before querying D1', async () => {
  const admin = await import('../admin-worker/index.mjs');
  const invalid = body();
  invalid.fixtureIds.push(invalid.fixtureIds[0]);
  let response = await admin.default.fetch(request(invalid), {
    ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: { prepare() { throw new Error('not reached'); } },
  });
  assert.equal(response.status, 422);

  const impossible = body();
  impossible.dateIndexCoverages[0].date = '2026-02-30';
  response = await admin.default.fetch(request(impossible), {
    ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: { prepare() { throw new Error('not reached'); } },
  });
  assert.equal(response.status, 422);

  const undeclared = body();
  delete undeclared.expectedTotals;
  response = await admin.default.fetch(request(undeclared), {
    ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: { prepare() { throw new Error('not reached'); } },
  });
  assert.equal(response.status, 422);

  const mismatchedExpectations = body();
  mismatchedExpectations.fixtureExpectations[0].fixtureId = 'af:fixture:9999';
  response = await admin.default.fetch(request(mismatchedExpectations), {
    ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: { prepare() { throw new Error('not reached'); } },
  });
  assert.equal(response.status, 422);
});

test('admin migration verification catches externally declared total mismatch outside item scopes', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const incomplete = body();
  incomplete.expectedTotals.publishedFixtures = 2;
  const response = await admin.default.fetch(request(incomplete), environment(db));
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.deepEqual(result.report.missingFixtureIds, []);
  assert.deepEqual(result.report.missingStandings, []);
  assert.deepEqual(result.report.totalMismatches, [
    { key: 'publishedFixtures', expected: 2, actual: 1 },
  ]);
});

test('the full migration verification request stays below body and D1 bind limits', async () => {
  const { assertMigrationVerifyRequest } = await import('../admin-worker/migration-verify.mjs');
  const admin = await import('../admin-worker/index.mjs');
  const archiveSha256 = 'a'.repeat(64);
  const fixtureIds = Array.from({ length: 365 }, (_, index) => `af:fixture:${index + 1}`);
  const fixtureExpectations = fixtureIds.map((fixtureId, index) => ({
    fixtureId, revisionNo: 1, contentSha256: index.toString(16).padStart(64, '0'),
  }));
  const competitionIds = Array.from({ length: 10 }, (_, index) => `af:competition:${index + 1}`);
  let remainingScopes = 620;
  const dateIndexCoverages = Array.from({ length: 178 }, (_, index) => {
    const remainingDates = 178 - index;
    const count = Math.ceil(remainingScopes / remainingDates);
    remainingScopes -= count;
    return {
      date: new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10),
      competitionIds: competitionIds.slice(0, count),
    };
  });
  const requestBody = {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'migration_verify',
    snapshotId: '20260908-021509068Z', archiveSha256, fixedSnapshot: null,
    fixtureIds, fixtureExpectations,
    standings: competitionIds.map((competitionId, index) => ({
      competitionId, seasonId: `af:season:${index + 1}:2026`,
    })),
    dateIndexCoverages,
    majorLeagueSeasons: competitionIds.map((competitionId, index) => ({
      competitionId, seasonId: `af:season:${index + 1}:2026`,
      startsOn: '2026-07-01', endsOn: '2027-06-30', teamCount: 20,
      fixtureCount: 342, publishedFixtureDetailCount: 37, standingsRowCount: 20,
      coreArtifactKey: `migration/api-football/v3/major-leagues/2026/${archiveSha256}`
        + `/leagues/${index + 1}/core-${'b'.repeat(64)}.json`,
      coreArtifactSha256: 'b'.repeat(64),
    })),
    expectedTotals: null,
  };
  assert.equal(remainingScopes, 0);
  assert.doesNotThrow(() => assertMigrationVerifyRequest(requestBody));
  assert.equal(Buffer.byteLength(JSON.stringify(requestBody)) < 256 * 1024, true);

  const bindCounts = [];
  const d1WithProductionBindLimit = {
    prepare(sql) {
      return {
        bind(...params) {
          bindCounts.push({ sql, count: params.length });
          assert.ok(params.length <= 100, `D1 query exceeded 100 bound parameters: ${params.length}`);
          return { async all() { return { results: [] }; } };
        },
      };
    },
  };
  const response = await admin.default.fetch(request(requestBody), {
    ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: d1WithProductionBindLimit,
  });
  assert.equal(response.status, 409);
  assert.equal(Math.max(...bindCounts.map(item => item.count)), 50);
  assert.deepEqual(bindCounts
    .filter(item => item.sql.includes('date_index_coverages'))
    .map(item => item.count), [50, 50, 50, 50, 50, 50, 28, 28]);
});
