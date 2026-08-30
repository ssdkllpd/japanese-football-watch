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

const PHASE2_PLAN_SCHEMA_VERSION = 'd1-phase2-readiness-plan/2';
const PHASE2_REPORT_SCHEMA_VERSION = 'd1-phase2-readiness-report/2';
const OPEN_ENDED_DATE = '9999-12-31';
const CORRECTION_DEFINITIONS_SCHEMA_VERSION = 'd1-fixture-correction-definitions/1';
const EXPECTATION_KEYS = [
  'fixtureRecordIds',
  'trackedPlayerIds',
  'ratingRecordIds',
  'aggregatePlayerIds',
];

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
    if (typeof fixture?.correctionsPath !== 'string' || !fixture.correctionsPath) {
      errors.push(`fixtures[${index}].correctionsPath is required`);
    }
  }
  if (!plan?.expectations || typeof plan.expectations !== 'object'
    || Array.isArray(plan.expectations)) {
    errors.push('expectations must be an object');
    return errors;
  }
  for (const key of EXPECTATION_KEYS) {
    const values = plan.expectations[key];
    if (!Array.isArray(values) || values.length === 0) {
      errors.push(`expectations.${key} must be a non-empty array`);
      continue;
    }
    const unique = new Set();
    for (const [index, value] of values.entries()) {
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`expectations.${key}[${index}] must be a non-empty string`);
      } else if (unique.has(value)) {
        errors.push(`duplicate expectations.${key}: ${value}`);
      }
      unique.add(value);
    }
  }
  return errors;
}

function validateCorrectionDefinitions(document, fixtureId) {
  const errors = [];
  if (document?.schemaVersion !== CORRECTION_DEFINITIONS_SCHEMA_VERSION) {
    errors.push('unsupported correction definitions schemaVersion');
  }
  if (document?.fixtureId !== fixtureId) errors.push('correction definitions fixtureId mismatch');
  if (!Array.isArray(document?.definitions)) {
    errors.push('correction definitions must be an array');
    return errors;
  }
  const keys = new Set();
  for (const [index, definition] of document.definitions.entries()) {
    if (definition?.correctionKey !== `${fixtureId}:${definition?.fieldPath || ''}`) {
      errors.push(`definitions[${index}].correctionKey must derive from fixtureId and fieldPath`);
    }
    if (!definition?.fieldPath) errors.push(`definitions[${index}].fieldPath is required`);
    if (keys.has(definition?.correctionKey)) {
      errors.push(`duplicate correctionKey: ${definition.correctionKey}`);
    }
    keys.add(definition?.correctionKey);
  }
  return errors;
}

function expectedScope(plan, snapshot, verifiedCoverage) {
  const recordIds = new Set(snapshot.data.playerMatchStats.map(record => record.recordId));
  const playerIds = new Set(snapshot.data.players.map(player => player.playerId));
  const recordsById = new Map(snapshot.data.playerMatchStats.map(record => [record.recordId, record]));
  const coverageByRecord = new Map(verifiedCoverage.records.map(record => [record.recordId, record]));
  const scope = Object.fromEntries(EXPECTATION_KEYS.map(key => [key, new Set(plan.expectations[key])]));
  const errors = [];
  for (const id of scope.fixtureRecordIds) if (!recordIds.has(id)) errors.push(`unknown fixtureRecordId: ${id}`);
  for (const id of scope.ratingRecordIds) if (!recordIds.has(id)) errors.push(`unknown ratingRecordId: ${id}`);
  for (const id of scope.trackedPlayerIds) if (!playerIds.has(id)) errors.push(`unknown trackedPlayerId: ${id}`);
  for (const id of scope.aggregatePlayerIds) if (!playerIds.has(id)) errors.push(`unknown aggregatePlayerId: ${id}`);
  for (const id of scope.ratingRecordIds) {
    if (!scope.fixtureRecordIds.has(id)) errors.push(`ratingRecordId is outside fixtureRecordIds: ${id}`);
    const playerId = recordsById.get(id)?.playerId;
    if (playerId && !scope.trackedPlayerIds.has(playerId)) {
      errors.push(`ratingRecordId player is outside trackedPlayerIds: ${id}`);
    }
  }
  for (const id of scope.aggregatePlayerIds) {
    if (!scope.trackedPlayerIds.has(id)) errors.push(`aggregatePlayerId is outside trackedPlayerIds: ${id}`);
  }
  const scopedFixtureIds = [...new Set([...scope.fixtureRecordIds]
    .map(recordId => coverageByRecord.get(recordId)?.canonicalFixtureId)
    .filter(Boolean))].sort();
  const planFixtureIds = plan.fixtures.map(fixture => fixture.fixtureId).sort();
  if (stableStringify(scopedFixtureIds) !== stableStringify(planFixtureIds)) {
    errors.push('plan fixtures must exactly match canonical fixtures referenced by fixtureRecordIds');
  }
  if (errors.length) throw new Error(`Invalid Phase 2 expected scope:\n- ${errors.join('\n- ')}`);
  return scope;
}

function recomputeFixtureCoverage(database, snapshot, coverage) {
  return verifyFixtureRecordParity(database, snapshot,
    linkFixtureRecords(database, snapshot, linkageBaseline(coverage)));
}

function fixtureRecordGate(snapshot, verifiedCoverage, expectedRecordIds) {
  const records = verifiedCoverage.records.filter(record => expectedRecordIds.has(record.recordId));
  const total = records.length;
  const linked = records.filter(record => record.recordLink?.state === 'linked').length;
  const passed = records.filter(record => record.factParity?.state === 'passed').length;
  return {
    passed: total > 0
      && total === expectedRecordIds.size
      && linked === total
      && passed === total,
    snapshotRecords: snapshot.data.playerMatchStats.length,
    expectedRecords: expectedRecordIds.size,
    notApplicableRecords: snapshot.data.playerMatchStats.length - expectedRecordIds.size,
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

function verifyResolvedCrosswalks(database, snapshot, verifiedCoverage, expectedPlayerIds) {
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
      if (!expectedPlayerIds.has(player.playerId)) {
        return { jfwPlayerId: player.playerId, status: 'not_applicable',
          reason: 'outside_phase2_expected_scope' };
      }
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
    passed: expectedPlayerIds.size > 0 && count('verified') === expectedPlayerIds.size
      && count('deferred') === 0 && count('failed') === 0,
    summary: {
      snapshotPlayers: players.length,
      expectedPlayers: expectedPlayerIds.size,
      verifiedPlayers: count('verified'),
      notApplicablePlayers: count('not_applicable'),
      deferredPlayers: count('deferred'),
      failedPlayers: count('failed'),
    },
    players,
  };
}

async function verifyFixtureShadows(database, plan, verifiedCoverage, expectedRecordIds, options = {}) {
  const baseDirectory = options.baseDirectory || process.cwd();
  const readJson = options.readJson || (filePath => JSON.parse(fs.readFileSync(filePath, 'utf8')));
  const expectedFixtureIds = [...new Set(verifiedCoverage.records
    .filter(record => expectedRecordIds.has(record.recordId))
    .map(record => record.canonicalFixtureId)
    .filter(Boolean))].sort();
  const planFixtureIds = plan.fixtures.map(fixture => fixture.fixtureId).sort();
  const planMatchesCoverage = stableStringify(expectedFixtureIds) === stableStringify(planFixtureIds);
  const fixtures = [];

  for (const fixture of [...plan.fixtures]
    .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId))) {
    try {
      const jsonBundle = readJson(resolveArtifactPath(baseDirectory, fixture.jsonPath));
      const correctionDocument = readJson(resolveArtifactPath(baseDirectory, fixture.correctionsPath));
      const correctionErrors = validateCorrectionDefinitions(correctionDocument, fixture.fixtureId);
      if (correctionErrors.length) {
        fixtures.push({ fixtureId: fixture.fixtureId, status: 'error',
          error: `invalid_correction_definitions: ${correctionErrors.join('; ')}` });
        continue;
      }
      const resolved = await new FixtureRepository(createLocalD1(database))
        .resolveFixture(fixture.fixtureId);
      if (!resolved || resolved.source !== 'd1' || !resolved.bundle) {
        fixtures.push({ fixtureId: fixture.fixtureId, status: 'error',
          error: 'fixture_did_not_resolve_from_d1' });
        continue;
      }
      const comparison = compareFixtureBundles(jsonBundle, resolved.bundle);
      const gitDefinitions = [...correctionDocument.definitions]
        .sort((left, right) => left.correctionKey.localeCompare(right.correctionKey));
      const jsonDefinitions = correctionDefinitions(jsonBundle)
        .sort((left, right) => left.correctionKey.localeCompare(right.correctionKey));
      const d1Definitions = correctionDefinitions(resolved.bundle)
        .sort((left, right) => left.correctionKey.localeCompare(right.correctionKey));
      const correctionDefinitionParity = {
        passed: stableStringify(gitDefinitions) === stableStringify(jsonDefinitions)
          && stableStringify(gitDefinitions) === stableStringify(d1Definitions),
        gitDefinitions,
        jsonDefinitions,
        d1Definitions,
      };
      const fixtureIdsMatch = comparison.json.fixtureId === fixture.fixtureId
        && comparison.d1.fixtureId === fixture.fixtureId;
      fixtures.push({ fixtureId: fixture.fixtureId,
        status: comparison.equal && fixtureIdsMatch && correctionDefinitionParity.passed
          ? 'equal' : 'different', comparison, correctionDefinitionParity });
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
  const scope = expectedScope(plan, snapshot, verifiedCoverage);
  const fixtureRecords = fixtureRecordGate(snapshot, verifiedCoverage, scope.fixtureRecordIds);
  const shadows = await verifyFixtureShadows(database, plan, verifiedCoverage,
    scope.fixtureRecordIds, options);
  const crosswalks = verifyResolvedCrosswalks(database, snapshot, verifiedCoverage,
    scope.trackedPlayerIds);
  const ratings = verifyTrackedPlayerRatings(database, snapshot, coverage, {
    expectedRecordIds: scope.ratingRecordIds,
    verifiedCoverage,
  });
  const aggregates = verifyTrackedPlayerAggregates(database, snapshot, coverage, {
    expectedPlayerIds: scope.aggregatePlayerIds,
    verifiedCoverage,
  });
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
    expectations: Object.fromEntries(EXPECTATION_KEYS.map(key => [key,
      [...scope[key]].sort()])),
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
  CORRECTION_DEFINITIONS_SCHEMA_VERSION,
  evaluatePhase2Readiness,
  expectedScope,
  expectedResolvedState,
  fixtureRecordGate,
  recomputeFixtureCoverage,
  resolvedStateForReadiness,
  validatePhase2ReadinessPlan,
  validateCorrectionDefinitions,
  verifyFixtureShadows,
  verifyResolvedCrosswalks,
};
