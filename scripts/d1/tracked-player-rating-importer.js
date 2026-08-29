'use strict';

const { artifactSha256, sha256, stableStringify, validateFixedSnapshot } = require('./fixed-snapshot');
const { validateCoverageManifest } = require('./fixture-coverage');
const { linkFixtureRecords } = require('./fixture-record-linkage');
const { verifyFixtureRecordParity } = require('./fixture-record-parity');
const { linkageBaseline } = require('./tracked-player-crosswalk-plan');

const RATING_IMPORT_REPORT_SCHEMA_VERSION = 'd1-tracked-player-rating-import-report/1';
const SUPPORTED_RATING_VERSION = '1.0';

const RATING_SCOPE_SQL = `
SELECT
  record.id AS player_record_id,
  fixture.published_revision AS rated_fixture_revision_id,
  player.canonical_id AS canonical_player_id,
  tracked.jfw_player_id,
  tracked.crosswalk_state,
  EXISTS (
    SELECT 1
    FROM tracking_periods period
    JOIN player_team_memberships membership ON membership.id = period.core_membership_id
    WHERE period.jfw_player_id = tracked.jfw_player_id
      AND membership.player_id = record.player_id
      AND membership.team_id = record.team_id
      AND period.competition_season_id = fixture.competition_season_id
      AND period.tracking_status = 'active'
      AND fixture.date_jst >= period.valid_from
      AND (period.valid_to = '9999-12-31' OR fixture.date_jst < period.valid_to)
  ) AS tracked_period_matches
FROM fixture_player_records record
JOIN fixtures fixture ON fixture.id = record.fixture_id
JOIN fixture_revisions revision
  ON revision.id = fixture.published_revision
  AND revision.fixture_id = fixture.id
  AND revision.lifecycle_state = 'published'
JOIN players player ON player.id = record.player_id
JOIN tracked_players tracked
  ON tracked.player_id = record.player_id
  AND tracked.jfw_player_id = ?2
WHERE record.id = ?1`;

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

function isRatingValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 3 && value <= 10;
}

function ratingInputsPayload(record) {
  return {
    authoredState: record.jfwRating === null ? 'authored_null' : 'authored_value',
    ratingInputs: record.ratingInputs || {},
    ratingInputsNote: record.ratingInputsNote ?? null,
    ratingPosition: record.ratingPosition ?? null,
    ratingPositionSource: record.ratingPositionSource ?? null,
    ratingOpsVersion: record.ratingOpsVersion ?? null,
    ratingCoverage: record.ratingCoverage ?? null,
    ratingConfidence: record.ratingConfidence ?? null,
    ratingFactors: record.ratingFactors ?? null,
    deltaPerformance: record.deltaPerformance ?? null,
    deltaDiscipline: record.deltaDiscipline ?? null,
    ratingBreakdown: record.ratingBreakdown || [],
    ratingSources: record.ratingSources || [],
    ratingConflicts: record.ratingConflicts || [],
    previousRating: record.previousRating ?? null,
    revisedAt: record.revisedAt ?? null,
    gaOnPitchAmbiguous: record.gaOnPitchAmbiguous ?? null,
  };
}

function ratingCandidate(record) {
  if (record.ratingVersion === undefined || record.ratingVersion === null || record.ratingVersion === '') {
    return { state: 'deferred', reason: 'authored_rating_version_missing' };
  }
  if (record.ratingVersion !== SUPPORTED_RATING_VERSION) {
    return { state: 'deferred', reason: 'authored_rating_version_unsupported' };
  }
  if (!Object.hasOwn(record, 'jfwRating') || record.jfwRating === undefined) {
    return { state: 'deferred', reason: 'authored_rating_missing' };
  }
  if (record.jfwRating === null) {
    return {
      state: 'ready',
      rating: null,
      ratingState: 'missing',
      inputs: ratingInputsPayload(record),
    };
  }
  if (!isRatingValue(record.jfwRating)) {
    return { state: 'deferred', reason: 'authored_rating_invalid' };
  }
  return {
    state: 'ready',
    rating: record.jfwRating,
    ratingState: 'computed',
    inputs: ratingInputsPayload(record),
  };
}

function storedRating(database, playerRecordId, ratingVersion) {
  return row(database, `SELECT
      player_record_id, jfw_player_id, rating_version, rated_fixture_revision_id,
      rating, rating_state, inputs_json, source_hash
    FROM jfw_rating_results
    WHERE player_record_id = ?1 AND rating_version = ?2`, playerRecordId, ratingVersion);
}

function expectedStoredRating(sourceRecord, coverageRecord, scope, candidate, snapshotHash) {
  const inputsJson = stableStringify(candidate.inputs);
  const fact = {
    playerRecordId: scope.player_record_id,
    jfwPlayerId: sourceRecord.playerId,
    ratingVersion: sourceRecord.ratingVersion,
    ratedFixtureRevisionId: scope.rated_fixture_revision_id,
    rating: candidate.rating,
    ratingState: candidate.ratingState,
    inputsJson,
    sourceRecordId: sourceRecord.recordId,
    canonicalFixtureId: coverageRecord.recordLink.canonicalFixtureId,
  };
  return { ...fact, sourceHash: sha256({ snapshotHash, ...fact }) };
}

function storedMatches(stored, expected) {
  if (!stored) return false;
  return stored.player_record_id === expected.playerRecordId
    && stored.jfw_player_id === expected.jfwPlayerId
    && stored.rating_version === expected.ratingVersion
    && stored.rated_fixture_revision_id === expected.ratedFixtureRevisionId
    && Object.is(stored.rating, expected.rating)
    && stored.rating_state === expected.ratingState
    && stored.inputs_json === expected.inputsJson
    && stored.source_hash === expected.sourceHash;
}

function importOneRating(database, expected) {
  return transaction(database, () => {
    const existing = storedRating(database, expected.playerRecordId, expected.ratingVersion);
    if (existing) {
      if (!storedMatches(existing, expected)) throw new Error('existing_rating_conflicts_with_fixed_snapshot');
      return 'already_imported';
    }
    run(database, `INSERT INTO jfw_rating_results(
      player_record_id, jfw_player_id, rating_version, rated_fixture_revision_id,
      rating, rating_state, inputs_json, source_hash
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    expected.playerRecordId, expected.jfwPlayerId, expected.ratingVersion,
    expected.ratedFixtureRevisionId, expected.rating, expected.ratingState,
    expected.inputsJson, expected.sourceHash);
    const inserted = storedRating(database, expected.playerRecordId, expected.ratingVersion);
    if (!storedMatches(inserted, expected)) throw new Error('inserted_rating_failed_roundtrip_validation');
    if (database.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('rating import failed foreign key validation');
    }
    return 'imported';
  });
}

function importTrackedPlayerRatings(database, snapshot, coverage) {
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
  const coverageByRecord = new Map(verifiedCoverage.records.map(record => [record.recordId, record]));
  const results = [];

  for (const sourceRecord of [...snapshot.data.playerMatchStats]
    .sort((left, right) => left.recordId.localeCompare(right.recordId))) {
    const coverageRecord = coverageByRecord.get(sourceRecord.recordId);
    if (coverageRecord?.recordLink?.state !== 'linked') {
      results.push({ recordId: sourceRecord.recordId, jfwPlayerId: sourceRecord.playerId,
        status: 'deferred', reason: 'canonical_record_not_linked' });
      continue;
    }
    if (coverageRecord.factParity?.state !== 'passed') {
      results.push({ recordId: sourceRecord.recordId, jfwPlayerId: sourceRecord.playerId,
        status: 'deferred', reason: 'canonical_fact_parity_not_passed' });
      continue;
    }
    if (sourceRecord.trackedAtMatch !== true) {
      results.push({ recordId: sourceRecord.recordId, jfwPlayerId: sourceRecord.playerId,
        status: 'deferred', reason: 'tracked_at_match_not_verified' });
      continue;
    }
    const candidate = ratingCandidate(sourceRecord);
    if (candidate.state !== 'ready') {
      results.push({ recordId: sourceRecord.recordId, jfwPlayerId: sourceRecord.playerId,
        status: 'deferred', reason: candidate.reason });
      continue;
    }
    const scope = row(database, RATING_SCOPE_SQL,
      coverageRecord.recordLink.playerRecordId, sourceRecord.playerId);
    if (!scope || scope.crosswalk_state !== 'resolved'
      || scope.canonical_player_id !== coverageRecord.recordLink.canonicalPlayerId) {
      results.push({ recordId: sourceRecord.recordId, jfwPlayerId: sourceRecord.playerId,
        status: 'deferred', reason: 'tracked_player_crosswalk_not_resolved' });
      continue;
    }
    if (!scope.tracked_period_matches) {
      results.push({ recordId: sourceRecord.recordId, jfwPlayerId: sourceRecord.playerId,
        status: 'deferred', reason: 'canonical_tracking_period_not_matched' });
      continue;
    }
    const expected = expectedStoredRating(sourceRecord, coverageRecord, scope, candidate, snapshotHash);
    try {
      const status = importOneRating(database, expected);
      results.push({
        recordId: sourceRecord.recordId,
        jfwPlayerId: sourceRecord.playerId,
        canonicalPlayerId: scope.canonical_player_id,
        playerRecordId: scope.player_record_id,
        ratingVersion: sourceRecord.ratingVersion,
        ratingState: candidate.ratingState,
        status,
      });
    } catch (error) {
      results.push({ recordId: sourceRecord.recordId, jfwPlayerId: sourceRecord.playerId,
        status: 'failed', error: error.message });
    }
  }

  const count = status => results.filter(result => result.status === status).length;
  const storedCount = row(database, 'SELECT COUNT(*) AS count FROM jfw_rating_results').count;
  const publishedCount = row(database, 'SELECT COUNT(*) AS count FROM published_jfw_rating_results').count;
  const acceptedCount = count('imported') + count('already_imported');
  return {
    schemaVersion: RATING_IMPORT_REPORT_SCHEMA_VERSION,
    snapshot: {
      artifactSha256: snapshotHash,
      inputSha256: snapshot.inputSha256,
      seasonId: snapshot.season.id,
    },
    productionReady: false,
    summary: {
      legacyMatchRecords: results.length,
      importedRatings: count('imported'),
      alreadyImportedRatings: count('already_imported'),
      deferredRatings: count('deferred'),
      failedRatings: count('failed'),
      acceptedRatings: acceptedCount,
      storedRatings: storedCount,
      publishedRatings: publishedCount,
      ratingGatePassed: results.length > 0
        && count('deferred') === 0
        && count('failed') === 0
        && acceptedCount === results.length
        && storedCount === acceptedCount
        && publishedCount === acceptedCount,
    },
    records: results,
  };
}

module.exports = {
  RATING_IMPORT_REPORT_SCHEMA_VERSION,
  RATING_SCOPE_SQL,
  SUPPORTED_RATING_VERSION,
  expectedStoredRating,
  importTrackedPlayerRatings,
  isRatingValue,
  ratingCandidate,
  ratingInputsPayload,
  storedMatches,
};
