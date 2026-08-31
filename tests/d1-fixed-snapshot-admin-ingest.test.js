'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const {
  aggregatePayload: localAggregatePayload,
  importFixedSnapshot,
} = require('../scripts/d1/fixed-snapshot-importer');
const {
  artifactSha256,
  buildFixedSnapshot,
  currentSnapshotInputs,
  stableStringify,
} = require('../scripts/d1/fixed-snapshot');

const migrations = ['0001_d1_core.sql', '0002_d1_date_index_coverage.sql', '0003_d1_standings_publication.sql']
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'migrations', file), 'utf8'));

function database() {
  const db = new DatabaseSync(':memory:');
  for (const migration of migrations) db.exec(migration);
  return db;
}

let retainedSnapshot;
function currentSnapshot() {
  if (retainedSnapshot) return retainedSnapshot;
  const root = path.join(__dirname, '..');
  const inputs = currentSnapshotInputs(root);
  retainedSnapshot = buildFixedSnapshot({
    ...inputs,
    createdAt: '2026-08-31T00:30:00.000Z',
    season: {
      id: inputs.seasonId,
      label: inputs.seasonId,
      startsOn: '2026-07-01',
      endsOn: '2027-06-30',
    },
  });
  return retainedSnapshot;
}

function ingestBody(snapshot = currentSnapshot(), artifact = artifactSha256(snapshot)) {
  return {
    schemaVersion: 'jfw-d1-admin-ingest/1',
    operation: 'fixed_snapshot_publish',
    artifactSha256: artifact,
    productSeasonId: `jfw:season:${snapshot.season.id}`,
  };
}

function request(body) {
  return new Request('https://admin.example/admin/v1/ingest', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function environment(db, snapshot = currentSnapshot(), advertisedHash = artifactSha256(snapshot)) {
  const key = `migration/fixed-snapshots/${advertisedHash}.json`;
  const raw = stableStringify(snapshot);
  return {
    ADMIN_INGEST_TOKEN: 'test-token',
    FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: {
      async get(requested) {
        return requested === key ? { async text() { return raw; } } : null;
      },
    },
  };
}

function semanticBootstrapRows(db) {
  return {
    sources: db.prepare('SELECT code, api_version FROM provider_sources ORDER BY code').all(),
    seasons: db.prepare(`
      SELECT canonical_id, label, starts_on, ends_on FROM product_seasons ORDER BY canonical_id
    `).all(),
    rawSnapshots: db.prepare(`
      SELECT source.code AS source, raw.r2_key, raw.content_sha256, raw.fetched_at,
        raw.retention_class, raw.byte_size
      FROM raw_snapshots raw JOIN provider_sources source ON source.id = raw.source_id
      ORDER BY raw.r2_key
    `).all(),
    syncRuns: db.prepare(`
      SELECT run_type, started_at, finished_at, status, requests_used, code_revision
      FROM sync_runs ORDER BY run_type, code_revision
    `).all(),
    trackedPlayers: db.prepare(`
      SELECT jfw_player_id, crosswalk_state, crosswalk_method, tracking_status,
        tracking_started_on, tracking_ended_on
      FROM tracked_players ORDER BY jfw_player_id
    `).all(),
    memberships: db.prepare(`
      SELECT jfw_player_id, legacy_team_label, legacy_competition_label,
        valid_from, valid_to, source_hash
      FROM legacy_tracking_memberships
      ORDER BY jfw_player_id, valid_from, valid_to, source_hash
    `).all(),
    periods: db.prepare(`
      SELECT period.jfw_player_id, legacy.source_hash AS legacy_source_hash,
        season.canonical_id AS competition_season_id, period.valid_from, period.valid_to,
        period.tracking_status, period.change_type, period.verification
      FROM tracking_periods period
      LEFT JOIN legacy_tracking_memberships legacy ON legacy.id = period.legacy_membership_id
      LEFT JOIN competition_seasons season ON season.id = period.competition_season_id
      ORDER BY period.jfw_player_id, period.valid_from, period.valid_to, legacy.source_hash
    `).all(),
    aggregates: db.prepare(`
      SELECT aggregate_row.jfw_player_id, season.canonical_id AS product_season_id,
        aggregate_row.aggregate_scope, aggregate_row.stats_json,
        aggregate_row.source_hash, aggregate_row.rebuilt_at
      FROM tracked_player_aggregates aggregate_row
      JOIN product_seasons season ON season.id = aggregate_row.product_season_id
      ORDER BY aggregate_row.jfw_player_id, aggregate_row.aggregate_scope
    `).all().map(row => ({ ...row, stats_json: JSON.parse(row.stats_json) })),
    recordSources: db.prepare(`
      SELECT record.fact_kind, record.fact_key, record.observed_at, record.verification,
        record.issue_flags_json, raw.content_sha256 AS raw_snapshot_sha256,
        sync.code_revision
      FROM record_sources record
      LEFT JOIN raw_snapshots raw ON raw.id = record.raw_snapshot_id
      LEFT JOIN sync_runs sync ON sync.id = record.sync_run_id
      ORDER BY record.fact_kind, record.fact_key
    `).all(),
  };
}

test('admin bootstrap atomically imports and replays the reviewed 64-player fixed snapshot', async t => {
  const db = database();
  t.after(() => db.close());
  const snapshot = currentSnapshot();
  const hash = artifactSha256(snapshot);
  assert.equal(hash, 'bfda9fa6e3bfdc5abaf1e37ffe1dc9962b7a557756be08bc3d1c366c4ba1fe49');
  assert.equal(snapshot.data.players.length, 64);
  assert.equal(snapshot.data.playerMatchStats.length, 120);
  assert.equal(snapshot.data.players.reduce(
    (count, player) => count + (player.membershipHistory || []).length, 0,
  ), 77);

  const shared = await import('../shared/fixed-snapshot-contract.mjs');
  for (const player of snapshot.data.players) {
    assert.deepEqual(shared.aggregatePayload(player), localAggregatePayload(player));
  }

  const admin = await import('../admin-worker/index.mjs');
  const env = environment(db, snapshot);
  const batch = env.FOOTBALL_DB.batch;
  let bootstrapStatementCount = 0;
  env.FOOTBALL_DB.batch = async statements => {
    bootstrapStatementCount = statements.length;
    return batch(statements);
  };
  let response = await admin.default.fetch(request(ingestBody(snapshot)), env);
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.report.status, 'imported');
  assert.equal(body.report.productionReady, false);
  assert.equal(bootstrapStatementCount <= 45, true, `D1 statement budget: ${bootstrapStatementCount}`);
  assert.deepEqual(body.report.counts, {
    rawSnapshots: 1,
    trackedPlayers: 64,
    legacyMemberships: 77,
    trackingPeriods: 77,
    seasonAggregates: 64,
    sourceRecords: 1,
    deferredLegacyMatchRecords: 120,
  });
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tracked_players').get().count, 64);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM legacy_tracking_memberships').get().count, 77);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tracking_periods').get().count, 77);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tracked_player_aggregates').get().count, 64);

  const stored = new Map(db.prepare(`
    SELECT jfw_player_id, stats_json FROM tracked_player_aggregates ORDER BY jfw_player_id
  `).all().map(row => [row.jfw_player_id, JSON.parse(row.stats_json)]));
  for (const player of snapshot.data.players) {
    assert.deepEqual(stored.get(player.playerId), localAggregatePayload(player));
  }

  const reviewedLocal = database();
  t.after(() => reviewedLocal.close());
  importFixedSnapshot(reviewedLocal, snapshot);
  assert.deepEqual(semanticBootstrapRows(db), semanticBootstrapRows(reviewedLocal));

  response = await admin.default.fetch(request(ingestBody(snapshot)), env);
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.report.status, 'already_imported');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_runs').get().count, 1);

  const evolved = db.prepare(`
    SELECT period.id AS period_id, period.jfw_player_id, legacy.id AS legacy_id,
      period.valid_from, period.valid_to
    FROM tracking_periods period
    JOIN legacy_tracking_memberships legacy ON legacy.id = period.legacy_membership_id
    WHERE period.jfw_player_id IN (
      SELECT jfw_player_id FROM tracking_periods GROUP BY jfw_player_id HAVING COUNT(*) = 1
    ) LIMIT 1
  `).get();
  db.exec(`
    INSERT INTO provider_sources(code, api_version) VALUES ('api-football', 'v3');
    INSERT INTO competitions(canonical_id, source_id, provider_id, name, type)
      VALUES ('af:competition:99999', (SELECT id FROM provider_sources WHERE code='api-football'), 99999, 'Test', 'League');
    INSERT INTO competition_seasons(
      canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (
      'af:season:99999:2026',
      (SELECT id FROM competitions WHERE canonical_id='af:competition:99999'),
      (SELECT id FROM product_seasons WHERE canonical_id='jfw:season:2026-27'),
      2026, '2026', 'active'
    );
    INSERT INTO teams(canonical_id, source_id, provider_id, name)
      VALUES ('af:team:99999', (SELECT id FROM provider_sources WHERE code='api-football'), 99999, 'Test Team');
    INSERT INTO players(canonical_id, source_id, provider_id, display_name)
      VALUES ('af:player:99999', (SELECT id FROM provider_sources WHERE code='api-football'), 99999, 'Test Player');
  `);
  const coreMembership = db.prepare(`
    INSERT INTO player_team_memberships(player_id, team_id, valid_from, valid_to, verification)
    VALUES (
      (SELECT id FROM players WHERE canonical_id='af:player:99999'),
      (SELECT id FROM teams WHERE canonical_id='af:team:99999'), ?, ?, 'verified'
    ) RETURNING id
  `).get(evolved.valid_from, evolved.valid_to);
  db.prepare(`
    UPDATE tracking_periods SET core_membership_id=?, legacy_membership_id=NULL,
      competition_season_id=(SELECT id FROM competition_seasons WHERE canonical_id='af:season:99999:2026'),
      verification='verified' WHERE id=?
  `).run(coreMembership.id, evolved.period_id);
  db.prepare(`
    UPDATE tracked_players SET player_id=(SELECT id FROM players WHERE canonical_id='af:player:99999'),
      crosswalk_state='resolved', crosswalk_method='test' WHERE jfw_player_id=?
  `).run(evolved.jfw_player_id);
  db.prepare('DELETE FROM legacy_tracking_memberships WHERE id=?').run(evolved.legacy_id);

  response = await admin.default.fetch(request(ingestBody(snapshot)), env);
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.report.status, 'already_imported');
  assert.equal(body.report.counts.legacyMemberships, 76);
  assert.equal(body.report.counts.resolvedLegacyPeriods, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_runs').get().count, 1);
});

test('admin bootstrap rejects external hash and product-season drift before D1 writes', async t => {
  const db = database();
  t.after(() => db.close());
  const snapshot = currentSnapshot();
  const wrongHash = 'a'.repeat(64);
  const admin = await import('../admin-worker/index.mjs');

  let response = await admin.default.fetch(
    request(ingestBody(snapshot, wrongHash)), environment(db, snapshot, wrongHash),
  );
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM raw_snapshots').get().count, 0);

  const wrongSeason = ingestBody(snapshot);
  wrongSeason.productSeasonId = 'jfw:season:2025-26';
  response = await admin.default.fetch(request(wrongSeason), environment(db, snapshot));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tracked_players').get().count, 0);
});

test('fixed snapshot integrity assertion rolls every bootstrap row back after silent underwrite', async t => {
  const db = database();
  t.after(() => db.close());
  const snapshot = currentSnapshot();
  const admin = await import('../admin-worker/index.mjs');
  const env = environment(db, snapshot);
  const prepare = env.FOOTBALL_DB.prepare;
  env.FOOTBALL_DB.prepare = sql => {
    if (!sql.includes('INSERT INTO tracked_player_aggregates')) return prepare(sql);
    return {
      bind() {
        return { async run() { return { success: true, meta: { changes: 0 } }; } };
      },
    };
  };
  const response = await admin.default.fetch(request(ingestBody(snapshot)), env);
  assert.equal(response.status, 422);
  for (const table of [
    'raw_snapshots', 'sync_runs', 'tracked_players', 'legacy_tracking_memberships',
    'tracking_periods', 'tracked_player_aggregates', 'record_sources',
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
});

test('fixed snapshot integrity assertion also detects a missing import sync run', async t => {
  const db = database();
  t.after(() => db.close());
  const snapshot = currentSnapshot();
  const admin = await import('../admin-worker/index.mjs');
  const env = environment(db, snapshot);
  const prepare = env.FOOTBALL_DB.prepare;
  env.FOOTBALL_DB.prepare = sql => {
    if (!sql.includes('INSERT INTO sync_runs(run_type')) return prepare(sql);
    return {
      bind() {
        return { async run() { return { success: true, meta: { changes: 0 } }; } };
      },
    };
  };
  const response = await admin.default.fetch(request(ingestBody(snapshot)), env);
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM raw_snapshots').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tracked_players').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_runs').get().count, 0);
});
