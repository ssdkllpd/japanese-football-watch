'use strict';

const { artifactSha256, validateFixedSnapshot } = require('./fixed-snapshot');
const { validateCoverageManifest } = require('./fixture-coverage');
const { linkFixtureRecords } = require('./fixture-record-linkage');
const { verifyFixtureRecordParity } = require('./fixture-record-parity');

const CROSSWALK_PLAN_SCHEMA_VERSION = 'd1-tracked-player-crosswalk-plan/1';
const CROSSWALK_METHOD = 'provider_fixture_player_period_id';

const LINK_EVIDENCE_SQL = `
SELECT
  fixture.canonical_id AS canonical_fixture_id,
  fixture.date_jst,
  revision.revision_no AS published_revision,
  revision.content_sha256,
  player.canonical_id AS canonical_player_id,
  player.provider_id AS provider_player_id,
  team.canonical_id AS canonical_team_id,
  team.provider_id AS provider_team_id,
  season.canonical_id AS competition_season_canonical_id,
  competition.provider_id AS provider_competition_id,
  appearance.id AS appearance_id
FROM fixture_player_records record
JOIN fixtures fixture ON fixture.id = record.fixture_id
JOIN fixture_revisions revision
  ON revision.id = fixture.published_revision
  AND revision.fixture_id = fixture.id
  AND revision.lifecycle_state = 'published'
JOIN players player ON player.id = record.player_id
JOIN provider_sources player_source
  ON player_source.id = player.source_id
  AND player_source.code = 'api-football'
JOIN teams team ON team.id = record.team_id
JOIN competition_seasons season ON season.id = fixture.competition_season_id
JOIN competitions competition ON competition.id = season.competition_id
LEFT JOIN fixture_player_appearances appearance
  ON appearance.player_record_id = record.id
  AND appearance.fixture_revision_id = revision.id
WHERE record.id = ?1`;

function positiveProviderId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
  });
}

function periodContainsDate(period, date) {
  return date >= period.validFrom && (period.validTo === '9999-12-31' || date < period.validTo);
}

function linkageBaseline(coverage) {
  const baseline = structuredClone(coverage);
  for (const record of baseline.records) {
    delete record.recordLink;
    delete record.factParity;
  }
  for (const fixture of baseline.fixtures) {
    delete fixture.recordLinkage;
    delete fixture.factParity;
  }
  for (const key of Object.keys(baseline.summary)) {
    if (key.startsWith('recordLink') || key.startsWith('factParity')) delete baseline.summary[key];
  }
  return baseline;
}

function legacyPeriods(database, jfwPlayerId) {
  return database.prepare(`SELECT
      period.id AS tracking_period_id,
      legacy.id AS legacy_membership_id,
      legacy.legacy_team_label,
      legacy.legacy_competition_label,
      period.valid_from,
      period.valid_to
    FROM tracking_periods period
    JOIN legacy_tracking_memberships legacy ON legacy.id = period.legacy_membership_id
    WHERE period.jfw_player_id = ?1
    ORDER BY period.valid_from, period.valid_to, period.id`).all(jfwPlayerId).map(item => ({
    trackingPeriodId: item.tracking_period_id,
    legacyMembershipId: item.legacy_membership_id,
    legacyTeamLabel: item.legacy_team_label,
    legacyCompetitionLabel: item.legacy_competition_label,
    validFrom: item.valid_from,
    validTo: item.valid_to,
  }));
}

function verifyLinkEvidence(database, coverageRecord) {
  const link = coverageRecord.recordLink;
  const row = database.prepare(LINK_EVIDENCE_SQL).get(link.playerRecordId);
  const matches = row
    && row.appearance_id
    && row.canonical_fixture_id === link.canonicalFixtureId
    && row.canonical_player_id === link.canonicalPlayerId
    && row.canonical_team_id === link.canonicalTeamId
    && row.provider_player_id === link.providerPlayerId
    && row.provider_team_id === link.providerTeamId
    && row.published_revision === link.publishedRevision
    && row.content_sha256 === coverageRecord.canonicalBundle?.contentSha256;
  if (!matches) throw new Error(`Coverage record link does not match the published D1 fact: ${coverageRecord.recordId}`);
  return {
    recordId: coverageRecord.recordId,
    canonicalFixtureId: row.canonical_fixture_id,
    fixtureDateJst: row.date_jst,
    canonicalPlayerId: row.canonical_player_id,
    providerPlayerId: row.provider_player_id,
    canonicalTeamId: row.canonical_team_id,
    providerTeamId: row.provider_team_id,
    competitionSeasonCanonicalId: row.competition_season_canonical_id,
    providerCompetitionId: row.provider_competition_id,
  };
}

function periodPlan(period, evidence) {
  const inPeriod = evidence.filter(item => periodContainsDate(period, item.fixtureDateJst));
  const usable = inPeriod.filter(item => item.trackedAtMatchExact
    && item.providerTeamExact && item.providerCompetitionExact);
  const candidates = new Map();
  for (const item of usable) {
    const key = `${item.canonicalTeamId}:${item.competitionSeasonCanonicalId}`;
    const candidate = candidates.get(key) || {
      teamCanonicalId: item.canonicalTeamId,
      competitionSeasonCanonicalId: item.competitionSeasonCanonicalId,
      evidenceRecordIds: [],
      evidenceFixtureIds: [],
    };
    candidate.evidenceRecordIds.push(item.recordId);
    candidate.evidenceFixtureIds.push(item.canonicalFixtureId);
    candidates.set(key, candidate);
  }
  const exactCandidates = [...candidates.values()].map(candidate => ({
    ...candidate,
    evidenceRecordIds: sortedUnique(candidate.evidenceRecordIds),
    evidenceFixtureIds: sortedUnique(candidate.evidenceFixtureIds),
  })).sort((left, right) => `${left.teamCanonicalId}:${left.competitionSeasonCanonicalId}`
    .localeCompare(`${right.teamCanonicalId}:${right.competitionSeasonCanonicalId}`));
  const rejectedEvidence = inPeriod.filter(item => !item.trackedAtMatchExact
      || !item.providerTeamExact || !item.providerCompetitionExact)
    .map(item => ({
      recordId: item.recordId,
      reason: !item.trackedAtMatchExact
        ? 'tracked_at_match_not_verified'
        : (!item.providerTeamExact
        ? 'provider_team_id_missing_or_mismatch'
        : 'provider_competition_id_missing_or_mismatch'),
    }));
  const state = exactCandidates.length === 1 ? 'ready'
    : (exactCandidates.length > 1 ? 'ambiguous' : 'deferred');
  return {
    ...period,
    state,
    reason: state === 'ready' ? 'exact_provider_period_match'
      : (state === 'ambiguous' ? 'multiple_exact_core_membership_candidates' : 'exact_period_evidence_missing'),
    candidates: exactCandidates,
    rejectedEvidence,
  };
}

function playerPlan(database, snapshotPlayer, snapshotRecords, coverageRecords) {
  const reasons = [];
  const providerPlayerIds = sortedUnique([
    positiveProviderId(snapshotPlayer.providerIds?.apiFootball?.player),
    ...snapshotRecords.map(record => positiveProviderId(record.providerIds?.apiFootball?.player)),
  ].filter(Boolean));
  if (providerPlayerIds.length === 0) reasons.push('provider_player_id_missing');
  if (providerPlayerIds.length > 1) reasons.push('provider_player_id_conflict');

  const linkedRecords = coverageRecords.filter(record => record.recordLink?.state === 'linked');
  const canonicalPlayerIds = sortedUnique(linkedRecords.map(record => record.recordLink.canonicalPlayerId));
  if (canonicalPlayerIds.length === 0) reasons.push('canonical_player_link_missing');
  if (canonicalPlayerIds.length > 1) reasons.push('canonical_player_id_conflict');

  const passedRecords = coverageRecords.filter(record => record.factParity?.state === 'passed');
  if (passedRecords.length === 0) reasons.push('fact_parity_passed_record_missing');
  const evidence = passedRecords.map(record => {
    const verified = verifyLinkEvidence(database, record);
    const source = snapshotRecords.find(item => item.recordId === record.recordId);
    const directTeamId = positiveProviderId(source?.providerIds?.apiFootball?.team);
    const directCompetitionId = positiveProviderId(source?.providerIds?.apiFootball?.league);
    return {
      ...verified,
      trackedAtMatchExact: source?.trackedAtMatch === true,
      providerTeamExact: directTeamId !== null && directTeamId === verified.providerTeamId,
      providerCompetitionExact: directCompetitionId !== null
        && directCompetitionId === verified.providerCompetitionId,
    };
  });

  let playerCanonicalId = canonicalPlayerIds.length === 1 ? canonicalPlayerIds[0] : null;
  if (playerCanonicalId && providerPlayerIds.length === 1) {
    const core = database.prepare(`SELECT player.canonical_id, player.provider_id
      FROM players player
      JOIN provider_sources source ON source.id = player.source_id AND source.code = 'api-football'
      WHERE player.canonical_id = ?1`).get(playerCanonicalId);
    if (!core) reasons.push('canonical_player_missing');
    else if (core.provider_id !== providerPlayerIds[0]) reasons.push('canonical_player_provider_id_mismatch');
  } else {
    playerCanonicalId = null;
  }

  const periods = legacyPeriods(database, snapshotPlayer.playerId).map(period => periodPlan(period, evidence));
  if (periods.length === 0) reasons.push('legacy_tracking_period_missing');
  if (periods.some(period => period.state === 'deferred')) reasons.push('period_mapping_incomplete');
  if (periods.some(period => period.state === 'ambiguous')) reasons.push('period_mapping_ambiguous');

  const uniqueReasons = sortedUnique(reasons);
  const status = uniqueReasons.includes('provider_player_id_conflict')
      || uniqueReasons.includes('canonical_player_id_conflict')
      || uniqueReasons.includes('period_mapping_ambiguous')
    ? 'ambiguous'
    : (uniqueReasons.length === 0 ? 'ready' : 'deferred');
  const result = {
    jfwPlayerId: snapshotPlayer.playerId,
    status,
    reasons: uniqueReasons,
    providerPlayerIds,
    canonicalPlayerIds,
    factParityPassedRecords: passedRecords.length,
    periods,
  };
  if (status === 'ready') {
    result.resolution = {
      jfwPlayerId: snapshotPlayer.playerId,
      playerCanonicalId,
      method: CROSSWALK_METHOD,
      memberships: periods.map(period => ({
        legacyMembershipId: period.legacyMembershipId,
        teamCanonicalId: period.candidates[0].teamCanonicalId,
        competitionSeasonCanonicalId: period.candidates[0].competitionSeasonCanonicalId,
        verification: 'provider',
      })),
    };
  }
  return result;
}

function buildTrackedPlayerCrosswalkPlan(database, snapshot, coverage) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A node:sqlite DatabaseSync instance is required.');
  }
  const snapshotErrors = validateFixedSnapshot(snapshot);
  if (snapshotErrors.length) throw new Error(`Invalid fixed snapshot:\n- ${snapshotErrors.join('\n- ')}`);
  const coverageErrors = validateCoverageManifest(coverage);
  if (coverageErrors.length) throw new Error(`Invalid fixture coverage manifest:\n- ${coverageErrors.join('\n- ')}`);
  const snapshotHash = artifactSha256(snapshot);
  if (coverage.snapshot?.artifactSha256 !== snapshotHash) {
    throw new Error('Fixture coverage manifest does not belong to the supplied fixed snapshot.');
  }
  const verifiedCoverage = verifyFixtureRecordParity(
    database,
    snapshot,
    linkFixtureRecords(database, snapshot, linkageBaseline(coverage)),
  );

  const tracked = database.prepare(`SELECT jfw_player_id, crosswalk_state
    FROM tracked_players ORDER BY jfw_player_id`).all();
  const snapshotPlayers = new Map(snapshot.data.players.map(player => [player.playerId, player]));
  if (tracked.length !== snapshotPlayers.size || tracked.some(item => !snapshotPlayers.has(item.jfw_player_id))) {
    throw new Error('Tracked players do not exactly match the fixed snapshot.');
  }
  const snapshotRecords = new Map();
  const snapshotRecordPlayers = new Map();
  for (const record of snapshot.data.playerMatchStats) {
    const items = snapshotRecords.get(record.playerId) || [];
    items.push(record);
    snapshotRecords.set(record.playerId, items);
    snapshotRecordPlayers.set(record.recordId, record.playerId);
  }
  if (snapshotRecordPlayers.size !== verifiedCoverage.records.length
    || verifiedCoverage.records.some(record => snapshotRecordPlayers.get(record.recordId) !== record.playerId)) {
    throw new Error('Fixture coverage records do not exactly match the fixed snapshot players.');
  }
  const coverageRecords = new Map();
  for (const record of verifiedCoverage.records) {
    const items = coverageRecords.get(record.playerId) || [];
    items.push(record);
    coverageRecords.set(record.playerId, items);
  }

  const players = tracked.map(item => {
    if (item.crosswalk_state === 'resolved') {
      return {
        jfwPlayerId: item.jfw_player_id,
        status: 'already_resolved',
        reasons: [],
      };
    }
    return playerPlan(
      database,
      snapshotPlayers.get(item.jfw_player_id),
      snapshotRecords.get(item.jfw_player_id) || [],
      coverageRecords.get(item.jfw_player_id) || [],
    );
  });
  const counts = status => players.filter(player => player.status === status).length;
  return {
    schemaVersion: CROSSWALK_PLAN_SCHEMA_VERSION,
    snapshot: {
      artifactSha256: snapshotHash,
      inputSha256: snapshot.inputSha256,
      seasonId: snapshot.season.id,
    },
    method: CROSSWALK_METHOD,
    productionReady: false,
    summary: {
      trackedPlayers: players.length,
      readyPlayers: counts('ready'),
      deferredPlayers: counts('deferred'),
      ambiguousPlayers: counts('ambiguous'),
      alreadyResolvedPlayers: counts('already_resolved'),
      resolutionPlanComplete: players.every(player => player.status === 'ready' || player.status === 'already_resolved'),
      crosswalkGatePassed: players.every(player => player.status === 'already_resolved'),
    },
    players,
  };
}

module.exports = {
  CROSSWALK_METHOD,
  CROSSWALK_PLAN_SCHEMA_VERSION,
  LINK_EVIDENCE_SQL,
  buildTrackedPlayerCrosswalkPlan,
  linkageBaseline,
  periodContainsDate,
};
