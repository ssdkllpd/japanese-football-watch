'use strict';

const {
  artifactSha256,
  membershipKey,
  sha256,
  stableStringify,
  validateFixedSnapshot,
} = require('./fixed-snapshot');

const LEGACY_SOURCE_CODE = 'legacy-json';
const RETENTION_CLASS = 'migration-fixed-snapshot';

function row(database, sql, ...params) {
  return database.prepare(sql).get(...params) || null;
}

function run(database, sql, ...params) {
  return database.prepare(sql).run(...params);
}

function transaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function aggregatePayload(player) {
  return {
    profile: {
      name: player.name || null,
      position: player.pos || null,
      currentClub: player.currentClub || player.club || null,
      currentLeague: player.currentLeague || player.league || null,
      trackingStatus: player.trackingStatus || 'active',
    },
    seasonStats: player.seasonStats || player.stats || {},
    allCompetitionsStats: player.allCompetitionsStats || {},
    competitionStats: player.competitionStats || {},
    clubStats: player.clubStats || {},
  };
}

function validateImportedSnapshot(database, snapshot) {
  const errors = [];
  const artifactHash = artifactSha256(snapshot);
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) errors.push(`foreign_key_check failed for ${foreignKeys.length} row(s)`);

  const xor = row(database, `SELECT COUNT(*) AS count FROM tracking_periods
    WHERE (core_membership_id IS NULL) = (legacy_membership_id IS NULL)`);
  if (xor.count) errors.push(`tracking membership XOR failed for ${xor.count} row(s)`);

  const resolvedLegacy = row(database, `SELECT COUNT(*) AS count
    FROM tracking_periods period
    JOIN tracked_players tracked ON tracked.jfw_player_id = period.jfw_player_id
    WHERE tracked.crosswalk_state = 'resolved' AND period.legacy_membership_id IS NOT NULL`);
  if (resolvedLegacy.count) errors.push(`resolved crosswalk retains ${resolvedLegacy.count} legacy period(s)`);

  const orphanLegacy = row(database, `SELECT COUNT(*) AS count
    FROM legacy_tracking_memberships legacy
    LEFT JOIN tracking_periods period ON period.legacy_membership_id = legacy.id
    WHERE period.id IS NULL`);
  if (orphanLegacy.count) errors.push(`unreferenced legacy membership rows: ${orphanLegacy.count}`);

  const rawSnapshot = row(database, `SELECT COUNT(*) AS count FROM raw_snapshots
    WHERE content_sha256 = ?1 AND retention_class = ?2`, artifactHash, RETENTION_CLASS);
  if (rawSnapshot.count !== 1) errors.push(`fixed raw snapshot reference count ${rawSnapshot.count} != 1`);
  const sourceRecord = row(database, `SELECT COUNT(*) AS count FROM record_sources
    WHERE fact_kind = 'fixed_snapshot' AND fact_key = ?1`, artifactHash);
  if (sourceRecord.count !== 1) errors.push(`fixed snapshot provenance count ${sourceRecord.count} != 1`);

  const expectedPlayers = snapshot.data.players.length;
  const tracked = row(database, 'SELECT COUNT(*) AS count FROM tracked_players');
  const aggregates = row(database, `SELECT COUNT(*) AS count FROM tracked_player_aggregates
    WHERE aggregate_scope = 'season' AND product_season_id = (
      SELECT id FROM product_seasons WHERE canonical_id = ?1
    )`, `jfw:season:${snapshot.season.id}`);
  if (tracked.count !== expectedPlayers) errors.push(`tracked player count ${tracked.count} != ${expectedPlayers}`);
  if (aggregates.count !== expectedPlayers) errors.push(`season aggregate count ${aggregates.count} != ${expectedPlayers}`);
  return errors;
}

function importFixedSnapshot(database, snapshot, options = {}) {
  if (!database || typeof database.prepare !== 'function') throw new TypeError('A node:sqlite DatabaseSync instance is required.');
  const snapshotErrors = validateFixedSnapshot(snapshot);
  if (snapshotErrors.length) throw new Error(`Invalid fixed snapshot:\n- ${snapshotErrors.join('\n- ')}`);

  const artifactHash = artifactSha256(snapshot);
  const existing = row(database, 'SELECT id FROM raw_snapshots WHERE content_sha256 = ?1', artifactHash);
  if (existing) {
    const errors = validateImportedSnapshot(database, snapshot);
    if (errors.length) throw new Error(`Existing fixed snapshot import is inconsistent:\n- ${errors.join('\n- ')}`);
    return { inputSha256: artifactHash, payloadSha256: snapshot.inputSha256, imported: false, reason: 'already_imported' };
  }
  const previous = row(database, 'SELECT content_sha256 FROM raw_snapshots WHERE retention_class = ?1 LIMIT 1', RETENTION_CLASS);
  if (previous) throw new Error(`A different fixed snapshot is already imported: ${previous.content_sha256}`);

  const crosswalks = options.crosswalks || {};
  const productSeasonId = `jfw:season:${snapshot.season.id}`;
  const result = transaction(database, () => {
    run(database, `INSERT INTO provider_sources(code, api_version) VALUES (?1, ?2)
      ON CONFLICT(code) DO UPDATE SET api_version = excluded.api_version`, LEGACY_SOURCE_CODE, snapshot.schemaVersion);
    const source = row(database, 'SELECT id FROM provider_sources WHERE code = ?1', LEGACY_SOURCE_CODE);

    run(database, `INSERT INTO product_seasons(canonical_id, label, starts_on, ends_on)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(canonical_id) DO UPDATE SET
        label = excluded.label, starts_on = excluded.starts_on, ends_on = excluded.ends_on`,
    productSeasonId, snapshot.season.label || snapshot.season.id, snapshot.season.startsOn, snapshot.season.endsOn);
    const productSeason = row(database, 'SELECT id FROM product_seasons WHERE canonical_id = ?1', productSeasonId);

    const canonicalArtifact = stableStringify(snapshot);
    const byteSize = Buffer.byteLength(canonicalArtifact);
    run(database, `INSERT INTO raw_snapshots(
      source_id, r2_key, content_sha256, fetched_at, retention_class, byte_size
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    source.id, `migration/fixed-snapshots/${artifactHash}.json`, artifactHash,
    snapshot.createdAt, RETENTION_CLASS, byteSize);
    const rawSnapshot = row(database, 'SELECT id FROM raw_snapshots WHERE content_sha256 = ?1', artifactHash);

    run(database, `INSERT INTO sync_runs(
      run_type, started_at, finished_at, status, requests_used, code_revision
    ) VALUES ('fixed_snapshot_import', ?1, ?1, 'completed', 0, ?2)`, snapshot.createdAt, artifactHash);
    const syncRun = row(database, 'SELECT last_insert_rowid() AS id');

    let membershipCount = 0;
    for (const player of snapshot.data.players) {
      const requested = crosswalks[player.playerId];
      const crosswalkState = requested?.state === 'ambiguous' ? 'ambiguous' : 'unresolved';
      if (requested?.state === 'resolved') {
        throw new Error(`Resolved crosswalk must use resolveTrackedPlayerCrosswalk after Core memberships exist: ${player.playerId}`);
      }
      run(database, `INSERT INTO tracked_players(
        jfw_player_id, player_id, crosswalk_state, crosswalk_method, crosswalk_sync_run_id,
        tracking_status, tracking_started_on, tracking_ended_on
      ) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, NULL)`,
      player.playerId, crosswalkState, requested?.method || null, syncRun.id,
      player.trackingStatus || 'active', snapshot.season.startsOn);

      for (const membership of player.membershipHistory || []) {
        const validFrom = membership.from || snapshot.season.startsOn;
        const validTo = membership.to || '9999-12-31';
        const identity = membershipKey(membership, snapshot.season.startsOn);
        const sourceHash = sha256({ inputSha256: artifactHash, playerId: player.playerId, identity });
        run(database, `INSERT INTO legacy_tracking_memberships(
          jfw_player_id, legacy_team_label, legacy_competition_label,
          valid_from, valid_to, source_hash
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        player.playerId, membership.club, membership.league, validFrom, validTo, sourceHash);
        const legacy = row(database, 'SELECT last_insert_rowid() AS id');
        run(database, `INSERT INTO tracking_periods(
          jfw_player_id, core_membership_id, legacy_membership_id, competition_season_id,
          valid_from, valid_to, tracking_status, change_type, verification
        ) VALUES (?1, NULL, ?2, NULL, ?3, ?4, ?5, ?6, 'legacy_unverified')`,
        player.playerId, legacy.id, validFrom, validTo,
        membership.tracked === false ? 'inactive' : (player.trackingStatus || 'active'),
        membership.changeType || 'legacy_import');
        membershipCount += 1;
      }

      const stats = aggregatePayload(player);
      run(database, `INSERT INTO tracked_player_aggregates(
        jfw_player_id, product_season_id, competition_season_id, team_id,
        aggregate_scope, stats_json, source_hash, rebuilt_at
      ) VALUES (?1, ?2, NULL, NULL, 'season', ?3, ?4, ?5)`,
      player.playerId, productSeason.id, JSON.stringify(stats),
      sha256({ inputSha256: artifactHash, playerId: player.playerId, stats }), snapshot.createdAt);
    }

    run(database, `INSERT INTO record_sources(
      sync_run_id, raw_snapshot_id, fact_kind, fact_key, observed_at, verification, issue_flags_json
    ) VALUES (?1, ?2, 'fixed_snapshot', ?3, ?4, 'legacy_unverified', '[]')`,
    syncRun.id, rawSnapshot.id, artifactHash, snapshot.createdAt);
    const imported = {
      inputSha256: artifactHash,
      payloadSha256: snapshot.inputSha256,
      imported: true,
      membershipCount,
      trackedPlayerCount: snapshot.data.players.length,
      deferredLegacyMatchRecords: snapshot.data.playerMatchStats.length,
      productionReady: snapshot.data.playerMatchStats.length === 0,
    };
    const errors = validateImportedSnapshot(database, snapshot);
    if (errors.length) throw new Error(`Fixed snapshot import failed validation:\n- ${errors.join('\n- ')}`);
    return imported;
  });
  return result;
}

function resolveTrackedPlayerCrosswalk(database, resolution) {
  const {
    jfwPlayerId,
    method,
    playerCanonicalId,
    syncRunId = null,
    memberships = [],
  } = resolution || {};
  if (!jfwPlayerId || !playerCanonicalId) throw new Error('jfwPlayerId and playerCanonicalId are required.');

  return transaction(database, () => {
    const tracked = row(database, 'SELECT * FROM tracked_players WHERE jfw_player_id = ?1', jfwPlayerId);
    if (!tracked) throw new Error(`Unknown tracked player: ${jfwPlayerId}`);
    const player = row(database, 'SELECT id FROM players WHERE canonical_id = ?1', playerCanonicalId);
    if (!player) throw new Error(`Core player does not exist: ${playerCanonicalId}`);
    const periods = database.prepare(`SELECT period.*, legacy.id AS legacy_id
      FROM tracking_periods period
      JOIN legacy_tracking_memberships legacy ON legacy.id = period.legacy_membership_id
      WHERE period.jfw_player_id = ?1`).all(jfwPlayerId);
    const mappingByLegacyId = new Map(memberships.map(item => [Number(item.legacyMembershipId), item]));
    if (mappingByLegacyId.size !== memberships.length) throw new Error('Core membership mappings contain duplicate legacy membership IDs.');
    if (periods.length !== mappingByLegacyId.size) throw new Error('Every legacy period must have exactly one Core membership mapping.');

    for (const period of periods) {
      const mapping = mappingByLegacyId.get(Number(period.legacy_id));
      if (!mapping) throw new Error(`Missing Core membership mapping for legacy membership ${period.legacy_id}`);
      const team = row(database, 'SELECT id FROM teams WHERE canonical_id = ?1', mapping.teamCanonicalId);
      const competitionSeason = row(database, 'SELECT id FROM competition_seasons WHERE canonical_id = ?1', mapping.competitionSeasonCanonicalId);
      if (!team || !competitionSeason) throw new Error(`Unknown Core team or competition season for legacy membership ${period.legacy_id}`);
      run(database, `INSERT INTO player_team_memberships(
        player_id, team_id, valid_from, valid_to, verification
      ) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(player_id, team_id, valid_from) DO UPDATE SET
        valid_to = excluded.valid_to, verification = excluded.verification`,
      player.id, team.id, period.valid_from, period.valid_to, mapping.verification || 'verified');
      const core = row(database, `SELECT id FROM player_team_memberships
        WHERE player_id = ?1 AND team_id = ?2 AND valid_from = ?3`, player.id, team.id, period.valid_from);
      run(database, `UPDATE tracking_periods SET
        core_membership_id = ?1, legacy_membership_id = NULL, competition_season_id = ?2,
        verification = ?3
        WHERE id = ?4`, core.id, competitionSeason.id, mapping.verification || 'verified', period.id);
    }

    run(database, `UPDATE tracked_players SET
      player_id = ?1, crosswalk_state = 'resolved', crosswalk_method = ?2, crosswalk_sync_run_id = ?3
      WHERE jfw_player_id = ?4`, player.id, method || 'manual_review', syncRunId, jfwPlayerId);
    run(database, `DELETE FROM legacy_tracking_memberships
      WHERE jfw_player_id = ?1
        AND NOT EXISTS (SELECT 1 FROM tracking_periods WHERE legacy_membership_id = legacy_tracking_memberships.id)`, jfwPlayerId);
    const unresolved = row(database, `SELECT COUNT(*) AS count FROM tracking_periods
      WHERE jfw_player_id = ?1 AND legacy_membership_id IS NOT NULL`, jfwPlayerId);
    if (unresolved.count) throw new Error(`Resolved crosswalk retains ${unresolved.count} legacy period(s).`);
    if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Crosswalk resolution failed foreign key validation.');
    return { jfwPlayerId, playerCanonicalId, resolvedPeriods: periods.length };
  });
}

module.exports = {
  importFixedSnapshot,
  resolveTrackedPlayerCrosswalk,
  validateImportedSnapshot,
};
