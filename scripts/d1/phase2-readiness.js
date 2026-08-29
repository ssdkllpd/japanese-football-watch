'use strict';

const fs = require('node:fs');
const { artifactSha256, stableStringify, validateFixedSnapshot } = require('./fixed-snapshot');
const { correctionDefinitions } = require('./fixture-bundle-importer');
const { validateCoverageManifest } = require('./fixture-coverage');
const { linkFixtureRecords } = require('./fixture-record-linkage');
const { verifyFixtureRecordParity } = require('./fixture-record-parity');
const { FixtureRepository } = require('./fixture-repository');
const { compareFixtureBundles } = require('./fixture-shadow-compare');
const { resolveArtifactPath } = require('./fixture-shadow-batch');
const { createLocalD1 } = require('./local-d1');
const {
  CROSSWALK_METHOD,
  LINK_EVIDENCE_SQL,
  linkageBaseline,
  periodContainsDate,
} = require('./tracked-player-crosswalk-plan');
const { verifyTrackedPlayerRatings } = require('./tracked-player-rating-importer');
const { verifyTrackedPlayerAggregates } = require('./tracked-player-aggregate-rebuilder');

const PHASE2_PLAN_SCHEMA_VERSION = 'd1-phase2-readiness-plan/1';
const PHASE2_REPORT_SCHEMA_VERSION = 'd1-phase2-readiness-report/1';
const OPEN_ENDED_DATE = '9999-12-31';

function row(database, sql, ...params) {
  return database.prepare(sql).get(...params) || null;
}

function positiveProviderId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validatePhase2ReadinessPlan(plan) {
  const errors = [];
  if (plan?.schemaVersion !== PHASE2_PLAN_SCHEMA_VERSION) {
    errors.push('unsupported readiness plan schemaVersion');
  }
  if (!Array.isArray(plan?.fixtures) || plan.fixtures.length === 0) {
    errors.push('fixtures must be a non-empty array');
    return errors;
  }
  const fixtureIds = new Set();
  for (const [index, fixture] of plan.fixtures.entries()) {
    if (!/^af:fixture:\d+$/.test(fixture?.fixtureId || '')) {
      errors.push(`fixtures[${index}].fixtureId must be canonical`);
    }
    if (fixtureIds.has(fixture?.fixtureId)) errors.push(`duplicate fixtureId: ${fixture.fixtureId}`);
    fixtureIds.add(fixture?.fixtureId);
    if (typeof fixture?.jsonPath !== 'string' || !fixture.jsonPath) {
      errors.push(`fixtures[${index}].jsonPath is required`);
    }
  }
  return errors;
}

function recomputeFixtureCoverage(database, snapshot, coverage) {
  return verifyFixtureRecordParity(database, snapshot,
    linkFixtureRecords(database, snapshot, linkageBaseline(coverage)));
}

function fixtureRecordGate(snapshot, verifiedCoverage) {
  const total = snapshot.data.playerMatchStats.length;
  const linked = verifiedCoverage.records.filter(record => record.recordLink?.state === 'linked').length;
  const passed = verifiedCoverage.records.filter(record => record.factParity?.state === 'passed').length;
  return {
    passed: total > 0
      && verifiedCoverage.records.length === total
      && linked === total
      && passed === total,
    totalRecords: total,
    linkedRecords: linked,
    parityPassedRecords: passed,
  };
}

function evidenceForRecord(database, coverageRecord) {
  const link = coverageRecord.recordLink;
  if (!link) return null;
  const evidence = row(database, LINK_EVIDENCE_SQL, link.playerRecordId);
  if (!evidence
    || !evidence.appearance_id
    || evidence.canonical_fixture_id !== link.canonicalFixtureId
    || evidence.canonical_player_id !== link.canonicalPlayerId
    || evidence.canonical_team_id !== link.canonicalTeamId
    || evidence.provider_player_id !== link.providerPlayerId
    || evidence.provider_team_id !== link.providerTeamId
    || evidence.published_revision !== link.publishedRevision
    || evidence.content_sha256 !== coverageRecord.canonicalBundle?.contentSha256) return null;
  return evidence;
}

function expectedResolvedState(database, snapshot, player, sourceRecords, coverageByRecord) {
  const providerPlayerIds = new Set([
    positiveProviderId(player.providerIds?.apiFootball?.player),
    ...sourceRecords.map(record => positiveProviderId(record.providerIds?.apiFootball?.player)),
  ].filter(Boolean));
  if (providerPlayerIds.size !== 1) {
    return { state: 'deferred', reason: 'provider_player_identity_not_exact' };
  }
  const evidence = [];
  for (const sourceRecord of sourceRecords) {
    const coverageRecord = coverageByRecord.get(sourceRecord.recordId);
    if (coverageRecord?.recordLink?.state !== 'linked'
      || coverageRecord.factParity?.state !== 'passed') {
      return { state: 'deferred', reason: 'fixture_record_gate_not_passed' };
    }
    const verified = evidenceForRecord(database, coverageRecord);
    if (!verified) return { state: 'deferred', reason: 'published_link_evidence_not_exact' };
    evidence.push({
      fixtureDateJst: verified.date_jst,
      canonicalPlayerId: verified.canonical_player_id,
      providerPlayerId: verified.provider_player_id,
      canonicalTeamId: verified.canonical_team_id,
      providerTeamId: verified.provider_team_id,
      competitionSeasonCanonicalId: verified.competition_season_canonical_id,
      providerCompetitionId: verified.provider_competition_id,
      sourceRecord,
    });
  }
  const canonicalPlayers = new Set(evidence.map(item => item.canonicalPlayerId));
  if (canonicalPlayers.size !== 1
    || new Set(evidence.map(item => item.providerPlayerId)).size !== 1
    || evidence[0]?.providerPlayerId !== [...providerPlayerIds][0]) {
    return { state: 'deferred', reason: 'canonical_player_identity_not_exact' };
  }

  const periods = [];
  for (const membership of player.membershipHistory || []) {
    const period = {
      validFrom: membership.from || snapshot.season.startsOn,
      validTo: membership.to || OPEN_ENDED_DATE,
    };
    const candidates = new Map();
    for (const item of evidence.filter(candidate => periodContainsDate(period, candidate.fixtureDateJst))) {
      const source = item.sourceRecord;
      const teamId = positiveProviderId(source.providerIds?.apiFootball?.team);
      const competitionId = positiveProviderId(source.providerIds?.apiFootball?.league);
      if (source.trackedAtMatch !== true
        || teamId === null || teamId !== item.providerTeamId
        || competitionId === null || competitionId !== item.providerCompetitionId) continue;
      candidates.set(`${item.canonicalTeamId}:${item.competitionSeasonCanonicalId}`, {
        teamCanonicalId: item.canonicalTeamId,
        competitionSeasonCanonicalId: item.competitionSeasonCanonicalId,
      });
    }
    if (candidates.size !== 1) {
      return { state: 'deferred', reason: candidates.size > 1
        ? 'resolved_period_evidence_ambiguous' : 'resolved_period_evidence_missing' };
    }
    periods.push({
      ...period,
      ...[...candidates.values()][0],
      trackingStatus: membership.tracked === false ? 'inactive' : (player.trackingStatus || 'active'),
      changeType: membership.changeType || 'legacy_import',
      verification: 'provider',
      membershipVerification: 'provider',
    });
  }
  if (periods.length === 0) return { state: 'deferred', reason: 'tracking_period_missing' };
  periods.sort((left, right) => `${left.validFrom}:${left.validTo}`.localeCompare(`${right.validFrom}:${right.validTo}`));
  return { state: 'ready', resolved: {
    playerCanonicalId: [...canonicalPlayers][0],
    method: CROSSWALK_METHOD,
    trackingStatus: player.trackingStatus || 'active',
    periods,
  } };
}

function resolvedStateForReadiness(database, jfwPlayerId) {
  const tracked = row(database, `SELECT
      tracked.crosswalk_state, tracked.crosswalk_method, tracked.tracking_status,
      player.canonical_id AS player_canonical_id
    FROM tracked_players tracked
    LEFT JOIN players player ON player.id = tracked.player_id
    WHERE tracked.jfw_player_id = ?1`, jfwPlayerId);
  if (!tracked || tracked.crosswalk_state !== 'resolved' || !tracked.player_canonical_id) return null;
  const periods = database.prepare(`SELECT
      period.valid_from, period.valid_to, period.tracking_status, period.change_type,
      period.verification, membership.verification AS membership_verification,
      team.canonical_id AS team_canonical_id,
      season.canonical_id AS competition_season_canonical_id
    FROM tracking_periods period
    JOIN player_team_memberships membership ON membership.id = period.core_membership_id
    JOIN teams team ON team.id = membership.team_id
    JOIN competition_seasons season ON season.id = period.competition_season_id
    WHERE period.jfw_player_id = ?1
    ORDER BY period.valid_from, period.valid_to, period.id`).all(jfwPlayerId).map(period => ({
    validFrom: period.valid_from,
    validTo: period.valid_to,
    teamCanonicalId: period.team_canonical_id,
    competitionSeasonCanonicalId: period.competition_season_canonical_id,
    trackingStatus: period.tracking_status,
    changeType: period.change_type,
    verification: period.verification,
    membershipVerification: period.membership_verification,
  }));
  return {
    playerCanonicalId: tracked.player_canonical_id,
    method: tracked.crosswalk_method,
    trackingStatus: tracked.tracking_status,
    periods,
  };
}

function verifyResolvedCrosswalks(database, snapshot, verifiedCoverage) {
  const sourceByPlayer = new Map();
  for (const record of snapshot.data.playerMatchStats) {
    const records = sourceByPlayer.get(record.playerId) || [];
    records.push(record);
    sourceByPlayer.set(record.playerId, records);
  }
  const coverageByRecord = new Map(verifiedCoverage.records.map(record => [record.recordId, record]));
  const players = [...snapshot.data.players]
    .sort((left, right) => left.playerId.localeCompare(right.playerId))
    .map(player => {
      const expected = expectedResolvedState(database, snapshot, player,
        sourceByPlayer.get(player.playerId) || [], coverageByRecord);
      if (expected.state !== 'ready') {
        return { jfwPlayerId: player.playerId, status: 'deferred', reason: expected.reason };
      }
      const actual = resolvedStateForReadiness(database, player.playerId);
      if (!actual) {
        return { jfwPlayerId: player.playerId, status: 'deferred',
          reason: 'tracked_player_crosswalk_not_resolved' };
      }
      actual.periods.sort((left, right) => `${left.validFrom}:${left.validTo}`
        .localeCompare(`${right.validFrom}:${right.validTo}`));
      if (stableStringify(actual) !== stableStringify(expected.resolved)) {
        return { jfwPlayerId: player.playerId, status: 'failed',
          reason: 'resolved_crosswalk_does_not_match_current_evidence' };
      }
      return { jfwPlayerId: player.playerId, status: 'verified',
        playerCanonicalId: actual.playerCanonicalId, trackingPeriods: actual.periods.length };
    });
  const count = status => players.filter(player => player.status === status).length;
  return {
    passed: players.length > 0 && count('verified') === players.length,
    summary: {
      trackedPlayers: players.length,
      verifiedPlayers: count('verified'),
      deferredPlayers: count('deferred'),
      failedPlayers: count('failed'),
    },
    players,
  };
}

async function verifyFixtureShadows(database, plan, verifiedCoverage, options = {}) {
  const baseDirectory = options.baseDirectory || process.cwd();
  const readJson = options.readJson || (filePath => JSON.parse(fs.readFileSync(filePath, 'utf8')));
  const expectedFixtureIds = [...new Set(verifiedCoverage.records
    .map(record => record.canonicalFixtureId)
    .filter(Boolean))].sort();
  const planFixtureIds = plan.fixtures.map(fixture => fixture.fixtureId).sort();
  const planMatchesCoverage = stableStringify(expectedFixtureIds) === stableStringify(planFixtureIds);
  const fixtures = [];

  for (const fixture of [...plan.fixtures]
    .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId))) {
    try {
      const jsonBundle = readJson(resolveArtifactPath(baseDirectory, fixture.jsonPath));
      const resolved = await new FixtureRepository(createLocalD1(database), {
        correctionDefinitions: correctionDefinitions(jsonBundle),
      }).resolveFixture(fixture.fixtureId);
      if (!resolved || resolved.source !== 'd1' || !resolved.bundle) {
        fixtures.push({ fixtureId: fixture.fixtureId, status: 'error',
          error: 'fixture_did_not_resolve_from_d1' });
        continue;
      }
      const comparison = compareFixtureBundles(jsonBundle, resolved.bundle);
      const fixtureIdsMatch = comparison.json.fixtureId === fixture.fixtureId
        && comparison.d1.fixtureId === fixture.fixtureId;
      fixtures.push({ fixtureId: fixture.fixtureId,
        status: comparison.equal && fixtureIdsMatch ? 'equal' : 'different', comparison });
    } catch (error) {
      fixtures.push({ fixtureId: fixture.fixtureId, status: 'error', error: error.message });
    }
  }
  const equal = fixtures.filter(fixture => fixture.status === 'equal').length;
  const different = fixtures.filter(fixture => fixture.status === 'different').length;
  const errors = fixtures.filter(fixture => fixture.status === 'error').length;
  return {
    passed: planMatchesCoverage && fixtures.length > 0 && equal === fixtures.length,
    summary: { expectedFixtures: expectedFixtureIds.length, plannedFixtures: planFixtureIds.length,
      planMatchesCoverage, equal, different, errors },
    fixtures,
  };
}

async function evaluatePhase2Readiness(database, snapshot, coverage, plan, options = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A node:sqlite DatabaseSync instance is required.');
  }
  const snapshotErrors = validateFixedSnapshot(snapshot);
  if (snapshotErrors.length) throw new Error(`Invalid fixed snapshot:\n- ${snapshotErrors.join('\n- ')}`);
  const coverageErrors = validateCoverageManifest(coverage);
  if (coverageErrors.length) throw new Error(`Invalid fixture coverage manifest:\n- ${coverageErrors.join('\n- ')}`);
  if (coverage.snapshot?.artifactSha256 !== artifactSha256(snapshot)) {
    throw new Error('Fixture coverage manifest does not belong to the supplied fixed snapshot.');
  }
  const planErrors = validatePhase2ReadinessPlan(plan);
  if (planErrors.length) throw new Error(`Invalid Phase 2 readiness plan:\n- ${planErrors.join('\n- ')}`);

  const verifiedCoverage = recomputeFixtureCoverage(database, snapshot, coverage);
  const fixtureRecords = fixtureRecordGate(snapshot, verifiedCoverage);
  const shadows = await verifyFixtureShadows(database, plan, verifiedCoverage, options);
  const crosswalks = verifyResolvedCrosswalks(database, snapshot, verifiedCoverage);
  const ratings = verifyTrackedPlayerRatings(database, snapshot, coverage);
  const aggregates = verifyTrackedPlayerAggregates(database, snapshot, coverage);
  const gates = {
    fixtureRecords: fixtureRecords.passed,
    fixtureShadows: shadows.passed,
    trackedPlayerCrosswalks: crosswalks.passed,
    jfwRatings: ratings.summary.ratingGatePassed,
    trackedPlayerAggregates: aggregates.summary.aggregateParityGatePassed,
  };
  const technicalGatePassed = Object.values(gates).every(Boolean);
  return {
    schemaVersion: PHASE2_REPORT_SCHEMA_VERSION,
    snapshot: { artifactSha256: artifactSha256(snapshot), inputSha256: snapshot.inputSha256,
      seasonId: snapshot.season.id },
    gates,
    phase2TechnicalGatePassed: technicalGatePassed,
    productionReady: false,
    phase3CutoverReady: false,
    remainingGates: technicalGatePassed
      ? ['claude_formal_review']
      : [...Object.entries(gates).filter(([, passed]) => !passed).map(([gate]) => gate),
        'claude_formal_review'],
    fixtureRecords,
    fixtureShadows: shadows,
    trackedPlayerCrosswalks: crosswalks,
    jfwRatings: ratings,
    trackedPlayerAggregates: aggregates,
  };
}

module.exports = {
  PHASE2_PLAN_SCHEMA_VERSION,
  PHASE2_REPORT_SCHEMA_VERSION,
  evaluatePhase2Readiness,
  expectedResolvedState,
  fixtureRecordGate,
  recomputeFixtureCoverage,
  resolvedStateForReadiness,
  validatePhase2ReadinessPlan,
  verifyFixtureShadows,
  verifyResolvedCrosswalks,
};
