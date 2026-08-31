import {
  aggregatePayload,
  assertValidFixedSnapshot,
  fixedSnapshotR2Key,
  membershipKey,
  sha256Hex,
  stableStringify,
} from '../shared/fixed-snapshot-contract.mjs';

export const FIXED_SNAPSHOT_OPERATION = 'fixed_snapshot_publish';
const LEGACY_SOURCE_CODE = 'legacy-json';
const RETENTION_CLASS = 'migration-fixed-snapshot';
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_BOOTSTRAP_STATEMENTS = 45;

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

export function assertFixedSnapshotRequest(input) {
  requireObject(input, 'Admin fixed snapshot ingest request');
  const allowed = new Set(['schemaVersion', 'operation', 'artifactSha256', 'productSeasonId']);
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Admin fixed snapshot request contains unknown fields: ${unknown.join(', ')}.`);
  if (input.operation !== FIXED_SNAPSHOT_OPERATION
    || !/^[0-9a-f]{64}$/.test(String(input.artifactSha256 || ''))
    || !/^jfw:season:\d{4}-\d{2}$/.test(String(input.productSeasonId || ''))) {
    throw new Error('Admin fixed snapshot scope is invalid.');
  }
  return input;
}

function statement(database, sql, params = []) {
  return database.prepare(sql).bind(...params);
}

async function first(database, sql, params = []) {
  return database.prepare(sql).bind(...params).first();
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function values(rows, width) {
  return rows.map(() => `(${Array.from({ length: width }, () => '?').join(', ')})`).join(', ');
}

function importedCounts(snapshot) {
  return {
    trackedPlayers: snapshot.data.players.length,
    legacyMemberships: snapshot.data.players.reduce(
      (count, player) => count + (player.membershipHistory || []).length, 0,
    ),
    trackingPeriods: snapshot.data.players.reduce(
      (count, player) => count + (player.membershipHistory || []).length, 0,
    ),
    seasonAggregates: snapshot.data.players.length,
  };
}

async function assertExistingImport(database, input, snapshot, sourceR2Key) {
  const row = await first(database, `
    SELECT raw.content_sha256, raw.r2_key,
      (SELECT COUNT(*) FROM raw_snapshots WHERE retention_class = ?) AS raw_count,
      (SELECT COUNT(*) FROM tracked_players) AS tracked_count,
      (SELECT COUNT(*) FROM legacy_tracking_memberships) AS membership_count,
      (SELECT COUNT(*) FROM tracking_periods) AS period_count,
      (SELECT COUNT(*) FROM tracking_periods WHERE legacy_membership_id IS NOT NULL) AS legacy_period_count,
      (SELECT COUNT(*) FROM legacy_tracking_memberships legacy
        LEFT JOIN tracking_periods period ON period.legacy_membership_id = legacy.id
        WHERE period.id IS NULL) AS orphan_membership_count,
      (SELECT COUNT(*) FROM tracking_periods period
        JOIN tracked_players tracked ON tracked.jfw_player_id = period.jfw_player_id
        WHERE tracked.crosswalk_state = 'resolved' AND period.legacy_membership_id IS NOT NULL
      ) AS resolved_legacy_count,
      (SELECT COUNT(*) FROM tracked_player_aggregates aggregate_row
        JOIN product_seasons season ON season.id = aggregate_row.product_season_id
        WHERE season.canonical_id = ? AND aggregate_row.aggregate_scope = 'season') AS aggregate_count,
      (SELECT COUNT(*) FROM record_sources
        WHERE fact_kind = 'fixed_snapshot' AND fact_key = ?) AS source_count
    FROM raw_snapshots raw
    WHERE raw.retention_class = ?
    ORDER BY raw.id LIMIT 1
  `, [RETENTION_CLASS, input.productSeasonId, input.artifactSha256, RETENTION_CLASS]);
  if (!row) return null;
  if (row.content_sha256 !== input.artifactSha256 || row.r2_key !== sourceR2Key) {
    throw new Error(`A different fixed snapshot is already imported: ${row.content_sha256}.`);
  }
  const expected = importedCounts(snapshot);
  const actual = {
    rawSnapshots: Number(row.raw_count),
    trackedPlayers: Number(row.tracked_count),
    legacyMemberships: Number(row.membership_count),
    trackingPeriods: Number(row.period_count),
    legacyTrackingPeriods: Number(row.legacy_period_count),
    orphanLegacyMemberships: Number(row.orphan_membership_count),
    resolvedLegacyPeriods: Number(row.resolved_legacy_count),
    seasonAggregates: Number(row.aggregate_count),
    sourceRecords: Number(row.source_count),
  };
  if (actual.rawSnapshots !== 1 || actual.sourceRecords !== 1
    || actual.trackedPlayers !== expected.trackedPlayers
    || actual.trackingPeriods !== expected.trackingPeriods
    || actual.legacyMemberships > expected.legacyMemberships
    || actual.legacyTrackingPeriods !== actual.legacyMemberships
    || actual.orphanLegacyMemberships !== 0 || actual.resolvedLegacyPeriods !== 0
    || actual.seasonAggregates !== expected.seasonAggregates) {
    throw new Error('Existing fixed snapshot import is incomplete.');
  }
  return actual;
}

async function preparedRows(snapshot, artifactSha256) {
  const memberships = [];
  for (const player of snapshot.data.players) {
    for (const membership of player.membershipHistory || []) {
      const validFrom = membership.from || snapshot.season.startsOn;
      const validTo = membership.to || '9999-12-31';
      const identity = membershipKey(membership, snapshot.season.startsOn);
      memberships.push({
        playerId: player.playerId,
        club: membership.club,
        league: membership.league,
        validFrom,
        validTo,
        trackingStatus: membership.tracked === false
          ? 'inactive' : (player.trackingStatus || 'active'),
        changeType: membership.changeType || 'legacy_import',
        sourceHash: await sha256Hex({ inputSha256: artifactSha256, playerId: player.playerId, identity }),
      });
    }
  }
  const aggregates = [];
  for (const player of snapshot.data.players) {
    const stats = aggregatePayload(player);
    aggregates.push({
      playerId: player.playerId,
      stats,
      sourceHash: await sha256Hex({ inputSha256: artifactSha256, playerId: player.playerId, stats }),
    });
  }
  return { memberships, aggregates };
}

async function bootstrapStatements(database, input, snapshot, sourceR2Key, byteSize) {
  const { memberships, aggregates } = await preparedRows(snapshot, input.artifactSha256);
  const expected = importedCounts(snapshot);
  const statements = [
    statement(database, `
      INSERT INTO provider_sources(code, api_version) VALUES (?, ?)
      ON CONFLICT(code) DO UPDATE SET api_version = excluded.api_version
    `, [LEGACY_SOURCE_CODE, snapshot.schemaVersion]),
    statement(database, `
      INSERT INTO product_seasons(canonical_id, label, starts_on, ends_on)
      VALUES (?, ?, ?, ?) ON CONFLICT(canonical_id) DO NOTHING
    `, [input.productSeasonId, snapshot.season.label || snapshot.season.id,
      snapshot.season.startsOn, snapshot.season.endsOn]),
    statement(database, `
      INSERT INTO raw_snapshots(source_id, r2_key, content_sha256, fetched_at, retention_class, byte_size)
      VALUES ((SELECT id FROM provider_sources WHERE code = ?), ?, ?, ?, ?, ?)
    `, [LEGACY_SOURCE_CODE, sourceR2Key, input.artifactSha256, snapshot.createdAt,
      RETENTION_CLASS, byteSize]),
    statement(database, `
      INSERT INTO sync_runs(run_type, started_at, finished_at, status, requests_used, code_revision)
      VALUES ('fixed_snapshot_import', ?, ?, 'completed', 0, ?)
    `, [snapshot.createdAt, snapshot.createdAt, input.artifactSha256]),
  ];

  for (const group of chunks(snapshot.data.players, 14)) {
    statements.push(statement(database, `
      INSERT INTO tracked_players(
        jfw_player_id, player_id, crosswalk_state, crosswalk_method, crosswalk_sync_run_id,
        tracking_status, tracking_started_on, tracking_ended_on
      ) VALUES ${group.map(() => `(?, NULL, 'unresolved', NULL,
        (SELECT id FROM sync_runs WHERE run_type = 'fixed_snapshot_import' AND code_revision = ?
          ORDER BY id DESC LIMIT 1), ?, ?, NULL)`).join(', ')}
    `, group.flatMap(player => [player.playerId, input.artifactSha256,
      player.trackingStatus || 'active', snapshot.season.startsOn])));
  }

  for (const group of chunks(memberships, 16)) {
    statements.push(statement(database, `
      INSERT INTO legacy_tracking_memberships(
        jfw_player_id, legacy_team_label, legacy_competition_label, valid_from, valid_to, source_hash
      ) VALUES ${values(group, 6)}
    `, group.flatMap(item => [item.playerId, item.club, item.league, item.validFrom,
      item.validTo, item.sourceHash])));
  }

  for (const group of chunks(memberships, 12)) {
    statements.push(statement(database, `
      INSERT INTO tracking_periods(
        jfw_player_id, core_membership_id, legacy_membership_id, competition_season_id,
        valid_from, valid_to, tracking_status, change_type, verification
      ) VALUES ${group.map(() => `(?, NULL, (SELECT id FROM legacy_tracking_memberships
        WHERE jfw_player_id = ? AND source_hash = ?), NULL, ?, ?, ?, ?, 'legacy_unverified')`).join(', ')}
    `, group.flatMap(item => [item.playerId, item.playerId, item.sourceHash,
      item.validFrom, item.validTo, item.trackingStatus, item.changeType])));
  }

  for (const group of chunks(aggregates, 10)) {
    statements.push(statement(database, `
      INSERT INTO tracked_player_aggregates(
        jfw_player_id, product_season_id, competition_season_id, team_id,
        aggregate_scope, stats_json, source_hash, rebuilt_at
      ) VALUES ${group.map(() => `(?, (SELECT id FROM product_seasons WHERE canonical_id = ?),
        NULL, NULL, 'season', ?, ?, ?)`).join(', ')}
    `, group.flatMap(item => [item.playerId, input.productSeasonId, JSON.stringify(item.stats),
      item.sourceHash, snapshot.createdAt])));
  }

  statements.push(statement(database, `
    INSERT INTO record_sources(
      sync_run_id, raw_snapshot_id, fact_kind, fact_key, observed_at, verification, issue_flags_json
    ) VALUES (
      (SELECT id FROM sync_runs WHERE run_type = 'fixed_snapshot_import' AND code_revision = ?
        ORDER BY id DESC LIMIT 1),
      (SELECT id FROM raw_snapshots WHERE content_sha256 = ?),
      'fixed_snapshot', ?, ?, 'legacy_unverified', '[]'
    )
  `, [input.artifactSha256, input.artifactSha256, input.artifactSha256, snapshot.createdAt]));

  statements.push(statement(database, `
    INSERT INTO sync_runs(
      run_type, started_at, finished_at, status, requests_used, code_revision
    ) VALUES (
      'fixed_snapshot_integrity_assertion',
      CASE WHEN
        (SELECT COUNT(*) FROM product_seasons
          WHERE canonical_id = ? AND starts_on = ? AND ends_on = ?) = 1
      AND (SELECT COUNT(*) FROM raw_snapshots WHERE retention_class = ?) = 1
      AND (SELECT COUNT(*) FROM tracked_players) = ?
      AND (SELECT COUNT(*) FROM tracked_players tracked
        JOIN sync_runs sync ON sync.id = tracked.crosswalk_sync_run_id
        WHERE sync.run_type = 'fixed_snapshot_import' AND sync.code_revision = ?) = ?
      AND (SELECT COUNT(*) FROM legacy_tracking_memberships) = ?
      AND (SELECT COUNT(*) FROM tracking_periods) = ?
      AND (SELECT COUNT(*) FROM tracked_player_aggregates aggregate_row
        JOIN product_seasons season ON season.id = aggregate_row.product_season_id
        WHERE season.canonical_id = ?
          AND aggregate_row.aggregate_scope = 'season') = ?
      AND (SELECT COUNT(*) FROM record_sources
        WHERE fact_kind = 'fixed_snapshot' AND fact_key = ?) = 1
      AND (SELECT COUNT(*) FROM sync_runs
        WHERE run_type = 'fixed_snapshot_import' AND code_revision = ?) = 1
      THEN ? ELSE 'fixed_snapshot_integrity_failure' END,
      ?, 'completed', 0, ?
    )
  `, [input.productSeasonId, snapshot.season.startsOn, snapshot.season.endsOn,
    RETENTION_CLASS, expected.trackedPlayers, input.artifactSha256, expected.trackedPlayers,
    expected.legacyMemberships, expected.trackingPeriods, input.productSeasonId,
    expected.seasonAggregates, input.artifactSha256, input.artifactSha256,
    snapshot.createdAt, snapshot.createdAt, input.artifactSha256]));
  statements.push(statement(database, `
    DELETE FROM sync_runs
    WHERE run_type = 'fixed_snapshot_integrity_assertion' AND code_revision = ?
  `, [input.artifactSha256]));

  if (statements.length > MAX_BOOTSTRAP_STATEMENTS) {
    throw new Error(`Fixed snapshot exceeds the D1 query budget (${statements.length}/${MAX_BOOTSTRAP_STATEMENTS}).`);
  }
  return { statements, expected };
}

export async function publishFixedSnapshotFromR2(env, input) {
  if (!env.FOOTBALL_DB || !env.FOOTBALL_DATA) throw new Error('Admin ingest bindings are unavailable.');
  assertFixedSnapshotRequest(input);
  const sourceR2Key = fixedSnapshotR2Key(input.artifactSha256);
  const object = await env.FOOTBALL_DATA.get(sourceR2Key);
  if (!object) {
    const error = new Error('Fixed snapshot R2 object is missing.');
    error.status = 404;
    throw error;
  }
  const raw = await object.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('Fixed snapshot R2 object exceeds the ingest limit.');
  }
  let snapshot;
  try { snapshot = JSON.parse(raw); } catch { throw new Error('Fixed snapshot R2 object is not JSON.'); }
  await assertValidFixedSnapshot(snapshot, input);
  const canonicalArtifact = stableStringify(snapshot);
  const byteSize = new TextEncoder().encode(canonicalArtifact).byteLength;
  const existing = await assertExistingImport(env.FOOTBALL_DB, input, snapshot, sourceR2Key);
  if (existing) {
    return {
      schemaVersion: 'jfw-d1-admin-ingest-report/1', operation: FIXED_SNAPSHOT_OPERATION,
      artifactSha256: input.artifactSha256, productSeasonId: input.productSeasonId,
      sourceR2Key, status: 'already_imported', counts: existing, productionReady: false,
    };
  }
  const bootstrap = await bootstrapStatements(
    env.FOOTBALL_DB, input, snapshot, sourceR2Key, byteSize,
  );
  await env.FOOTBALL_DB.batch(bootstrap.statements);
  return {
    schemaVersion: 'jfw-d1-admin-ingest-report/1', operation: FIXED_SNAPSHOT_OPERATION,
    artifactSha256: input.artifactSha256, productSeasonId: input.productSeasonId,
    sourceR2Key, status: 'imported', counts: {
      rawSnapshots: 1, ...bootstrap.expected, sourceRecords: 1,
      deferredLegacyMatchRecords: snapshot.data.playerMatchStats.length,
    },
    productionReady: false,
  };
}
