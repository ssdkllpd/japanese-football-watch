'use strict';

const { artifactSha256, sha256, stableStringify, validateFixedSnapshot } = require('./fixed-snapshot');
const { validateCoverageManifest } = require('./fixture-coverage');
const { resolveTrackedPlayerCrosswalk } = require('./fixed-snapshot-importer');
const {
  CROSSWALK_METHOD,
  CROSSWALK_PLAN_SCHEMA_VERSION,
  buildTrackedPlayerCrosswalkPlan,
} = require('./tracked-player-crosswalk-plan');

const APPLY_REPORT_SCHEMA_VERSION = 'd1-tracked-player-crosswalk-apply-report/1';

function row(database, sql, ...params) {
  return database.prepare(sql).get(...params) || null;
}

function run(database, sql, ...params) {
  return database.prepare(sql).run(...params);
}

function validatePlan(plan, snapshot) {
  const errors = [];
  const players = plan?.players || [];
  if (plan?.schemaVersion !== CROSSWALK_PLAN_SCHEMA_VERSION) errors.push('unsupported plan schemaVersion');
  if (plan?.method !== CROSSWALK_METHOD) errors.push('unsupported crosswalk method');
  if (!Array.isArray(plan?.players)) errors.push('players must be an array');
  if (new Set(players.map(player => player.jfwPlayerId)).size !== players.length) {
    errors.push('jfwPlayerId plan entries must be unique');
  }
  const snapshotHash = artifactSha256(snapshot);
  if (plan?.snapshot?.artifactSha256 !== snapshotHash
    || plan?.snapshot?.inputSha256 !== snapshot.inputSha256
    || plan?.snapshot?.seasonId !== snapshot.season.id) {
    errors.push('plan does not belong to the fixed snapshot');
  }
  const validStatuses = new Set(['ready', 'deferred', 'ambiguous', 'already_resolved']);
  if (players.some(player => !validStatuses.has(player.status))) errors.push('plan player status is invalid');
  if (players.some(player => (player.status === 'ready') !== Boolean(player.resolution))) {
    errors.push('only ready players must contain a resolution');
  }
  return errors;
}

function currentResolvedState(database, jfwPlayerId) {
  const tracked = row(database, `SELECT tracked.crosswalk_state, player.canonical_id AS player_canonical_id
    FROM tracked_players tracked
    LEFT JOIN players player ON player.id = tracked.player_id
    WHERE tracked.jfw_player_id = ?1`, jfwPlayerId);
  if (!tracked || tracked.crosswalk_state !== 'resolved') return null;
  const periods = database.prepare(`SELECT
      period.valid_from,
      period.valid_to,
      team.canonical_id AS team_canonical_id,
      season.canonical_id AS competition_season_canonical_id
    FROM tracking_periods period
    JOIN player_team_memberships membership ON membership.id = period.core_membership_id
    JOIN teams team ON team.id = membership.team_id
    JOIN competition_seasons season ON season.id = period.competition_season_id
    WHERE period.jfw_player_id = ?1
    ORDER BY period.valid_from, period.valid_to, period.id`).all(jfwPlayerId).map(item => ({
    validFrom: item.valid_from,
    validTo: item.valid_to,
    teamCanonicalId: item.team_canonical_id,
    competitionSeasonCanonicalId: item.competition_season_canonical_id,
  }));
  return { playerCanonicalId: tracked.player_canonical_id, periods };
}

function plannedResolvedState(planPlayer) {
  if (!planPlayer?.resolution || !Array.isArray(planPlayer.periods)) return null;
  const mappingByLegacyId = new Map(planPlayer.resolution.memberships
    .map(mapping => [Number(mapping.legacyMembershipId), mapping]));
  const periods = [];
  for (const period of planPlayer.periods) {
    const mapping = mappingByLegacyId.get(Number(period.legacyMembershipId));
    if (!mapping) return null;
    periods.push({
      validFrom: period.validFrom,
      validTo: period.validTo,
      teamCanonicalId: mapping.teamCanonicalId,
      competitionSeasonCanonicalId: mapping.competitionSeasonCanonicalId,
    });
  }
  return { playerCanonicalId: planPlayer.resolution.playerCanonicalId, periods };
}

function resolvedStateMatches(database, planPlayer) {
  const expected = plannedResolvedState(planPlayer);
  const actual = currentResolvedState(database, planPlayer.jfwPlayerId);
  return Boolean(expected && actual && stableStringify(expected) === stableStringify(actual));
}

function createSyncRun(database, snapshot, plan) {
  const revision = sha256({
    schemaVersion: plan.schemaVersion,
    snapshot: plan.snapshot,
    method: plan.method,
    players: plan.players,
  });
  run(database, `INSERT INTO sync_runs(
    run_type, started_at, finished_at, status, requests_used, code_revision
  ) VALUES ('tracked_player_crosswalk_apply', ?1, NULL, 'running', 0, ?2)`, snapshot.createdAt, revision);
  return row(database, 'SELECT last_insert_rowid() AS id').id;
}

function finishSyncRun(database, syncRunId, snapshot, failed) {
  run(database, `UPDATE sync_runs SET finished_at = ?1, status = ?2 WHERE id = ?3`,
    snapshot.createdAt, failed ? 'completed_with_errors' : 'completed', syncRunId);
}

function applyTrackedPlayerCrosswalkPlan(database, snapshot, coverage, plan) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A node:sqlite DatabaseSync instance is required.');
  }
  const snapshotErrors = validateFixedSnapshot(snapshot);
  if (snapshotErrors.length) throw new Error(`Invalid fixed snapshot:\n- ${snapshotErrors.join('\n- ')}`);
  const coverageErrors = validateCoverageManifest(coverage);
  if (coverageErrors.length) throw new Error(`Invalid fixture coverage manifest:\n- ${coverageErrors.join('\n- ')}`);
  const planErrors = validatePlan(plan, snapshot);
  if (planErrors.length) throw new Error(`Invalid tracked player crosswalk plan:\n- ${planErrors.join('\n- ')}`);

  const currentPlan = buildTrackedPlayerCrosswalkPlan(database, snapshot, coverage);
  const currentByPlayer = new Map(currentPlan.players.map(player => [player.jfwPlayerId, player]));
  if (plan.players.length !== currentPlan.players.length
    || plan.players.some(player => !currentByPlayer.has(player.jfwPlayerId))) {
    throw new Error('Crosswalk plan players do not exactly match the current fixed snapshot import.');
  }

  const results = [];
  const candidates = [];
  for (const planPlayer of plan.players) {
    const current = currentByPlayer.get(planPlayer.jfwPlayerId);
    if (planPlayer.status !== 'ready') {
      results.push({
        jfwPlayerId: planPlayer.jfwPlayerId,
        planStatus: planPlayer.status,
        status: current.status === planPlayer.status ? 'deferred' : 'stale',
        reason: current.status === planPlayer.status
          ? 'plan_player_not_ready'
          : 'current_crosswalk_state_changed',
      });
      continue;
    }
    if (current.status === 'already_resolved' && resolvedStateMatches(database, planPlayer)) {
      results.push({
        jfwPlayerId: planPlayer.jfwPlayerId,
        planStatus: 'ready',
        status: 'already_resolved',
        reason: 'planned_resolution_already_applied',
      });
      continue;
    }
    if (current.status !== 'ready'
      || stableStringify(current.resolution) !== stableStringify(planPlayer.resolution)) {
      results.push({
        jfwPlayerId: planPlayer.jfwPlayerId,
        planStatus: 'ready',
        status: 'stale',
        reason: 'planned_resolution_no_longer_matches_current_evidence',
      });
      continue;
    }
    candidates.push(planPlayer);
  }

  let syncRunId = null;
  if (candidates.length) syncRunId = createSyncRun(database, snapshot, plan);
  let failed = false;
  for (const player of candidates) {
    try {
      const resolution = { ...player.resolution, syncRunId };
      const applied = resolveTrackedPlayerCrosswalk(database, resolution);
      results.push({
        jfwPlayerId: player.jfwPlayerId,
        planStatus: 'ready',
        status: 'resolved',
        playerCanonicalId: applied.playerCanonicalId,
        resolvedPeriods: applied.resolvedPeriods,
      });
    } catch (error) {
      failed = true;
      results.push({
        jfwPlayerId: player.jfwPlayerId,
        planStatus: 'ready',
        status: 'failed',
        error: error.message,
      });
    }
  }
  if (syncRunId !== null) finishSyncRun(database, syncRunId, snapshot, failed);

  results.sort((left, right) => left.jfwPlayerId.localeCompare(right.jfwPlayerId));
  const after = buildTrackedPlayerCrosswalkPlan(database, snapshot, coverage);
  const count = status => results.filter(result => result.status === status).length;
  return {
    schemaVersion: APPLY_REPORT_SCHEMA_VERSION,
    snapshot: plan.snapshot,
    method: plan.method,
    syncRunId,
    productionReady: false,
    summary: {
      plannedReadyPlayers: plan.players.filter(player => player.status === 'ready').length,
      resolvedPlayers: count('resolved'),
      alreadyResolvedPlayers: count('already_resolved'),
      deferredPlayers: count('deferred'),
      stalePlayers: count('stale'),
      failedPlayers: count('failed'),
      remainingDeferredPlayers: after.summary.deferredPlayers,
      remainingAmbiguousPlayers: after.summary.ambiguousPlayers,
      crosswalkGatePassed: after.summary.crosswalkGatePassed,
    },
    players: results,
  };
}

module.exports = {
  APPLY_REPORT_SCHEMA_VERSION,
  applyTrackedPlayerCrosswalkPlan,
  currentResolvedState,
  plannedResolvedState,
  resolvedStateMatches,
  validatePlan,
};
