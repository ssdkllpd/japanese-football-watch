'use strict';

const { artifactSha256, validateFixedSnapshot } = require('./fixed-snapshot');
const { reasonCounts, validateCoverageManifest } = require('./fixture-coverage');

const FIELD_MAP = Object.freeze({
  minutes: 'minutes',
  goals: 'goals',
  assists: 'assists',
  gaOnPitch: 'goalsConceded',
  saves: 'saves',
  shots: 'shots',
  shotsOnTarget: 'shotsOnTarget',
  keyPasses: 'keyPasses',
  passesAttempted: 'passes',
  passesCompleted: 'passAccuracy',
  tackles: 'tackles',
  blocks: 'blocks',
  interceptions: 'interceptions',
  duelsTotal: 'duels',
  duelsWon: 'duelsWon',
  dribbles: 'dribbles',
  dribbledPast: 'dribbledPast',
  yellowCards: 'yellowCards',
  penaltiesConceded: 'penaltiesConceded',
  penaltiesSaved: 'penaltiesSaved',
});

const RECORD_SQL = `
SELECT
  fixture.canonical_id AS canonical_fixture_id,
  revision.id AS fixture_revision_id,
  revision.revision_no,
  record.id AS player_record_id,
  player.canonical_id AS canonical_player_id,
  team.canonical_id AS canonical_team_id,
  appearance.appearance_state,
  stats.player_appearance_id IS NOT NULL AS has_player_stats,
  stats.minutes,
  stats.provider_rating AS rating,
  stats.goals,
  stats.assists,
  stats.goals_conceded AS goalsConceded,
  stats.saves,
  stats.shots,
  stats.shots_on_target AS shotsOnTarget,
  stats.passes,
  stats.key_passes AS keyPasses,
  stats.pass_accuracy AS passAccuracy,
  stats.tackles,
  stats.blocks,
  stats.interceptions,
  stats.duels,
  stats.duels_won AS duelsWon,
  stats.dribbles,
  stats.dribbled_past AS dribbledPast,
  stats.yellow_cards AS yellowCards,
  stats.penalties_conceded AS penaltiesConceded,
  stats.penalties_saved AS penaltiesSaved
FROM fixture_player_records record
JOIN fixtures fixture ON fixture.id = record.fixture_id
JOIN fixture_revisions revision
  ON revision.id = fixture.published_revision
  AND revision.fixture_id = fixture.id
  AND revision.lifecycle_state = 'published'
JOIN players player ON player.id = record.player_id
JOIN teams team ON team.id = record.team_id
JOIN fixture_player_appearances appearance
  ON appearance.player_record_id = record.id
  AND appearance.fixture_revision_id = revision.id
LEFT JOIN fixture_player_stats stats ON stats.player_appearance_id = appearance.id
WHERE record.id = ?1`;

const FIELD_STATES_SQL = `
SELECT field_path, presence
FROM field_states
WHERE fixture_revision_id = ?1
  AND fact_kind = 'player_stat'
  AND fact_key = ?2`;

function expectedAppearanceState(record) {
  if (record.start === true) return 'started';
  if (record.appearance === true && record.start === false) return 'substitute_used';
  if (record.appearance === false && record.bench === true) return 'bench_unused';
  return null;
}

function sameStoredNumber(left, right) {
  return typeof left === 'number' && Number.isFinite(left)
    && typeof right === 'number' && Number.isFinite(right)
    && Object.is(left, right);
}

function compareValue(facts, legacyField, canonicalField, legacyValue, canonicalValue, presence) {
  facts.compared += 1;
  if (sameStoredNumber(legacyValue, canonicalValue)) {
    facts.matched += 1;
    return;
  }
  facts.mismatches.push({
    legacyField,
    canonicalField,
    kind: canonicalValue === null || canonicalValue === undefined ? 'canonical_missing' : 'value_mismatch',
    legacy: legacyValue,
    canonical: canonicalValue ?? null,
    canonicalPresence: presence || (canonicalValue === null || canonicalValue === undefined ? 'unknown' : 'present'),
  });
}

function compareLegacyRecordFacts(legacyRecord, canonical) {
  const facts = {
    state: 'not_comparable',
    compared: 0,
    matched: 0,
    canonicalEnrichments: [],
    missingOnBoth: [],
    notCompared: [],
    mismatches: [],
  };
  const values = canonical?.values || {};
  const fieldStates = canonical?.fieldStates || {};

  for (const [legacyField, input] of Object.entries(legacyRecord?.ratingInputs || {})) {
    const canonicalField = FIELD_MAP[legacyField];
    if (!canonicalField) {
      facts.notCompared.push({ legacyField, legacyState: input?.state || 'unknown', reason: 'no_safe_canonical_mapping' });
      continue;
    }
    const canonicalValue = values[canonicalField];
    const presence = fieldStates[canonicalField] || null;
    if (input?.state === 'value') {
      compareValue(facts, legacyField, canonicalField, input.value, canonicalValue, presence);
    } else if (input?.state === 'missing') {
      if (canonicalValue === null || canonicalValue === undefined) {
        facts.missingOnBoth.push({ legacyField, canonicalField, canonicalPresence: presence || 'unknown' });
      } else {
        facts.canonicalEnrichments.push({ legacyField, canonicalField, canonical: canonicalValue });
      }
    } else {
      facts.notCompared.push({ legacyField, legacyState: input?.state || 'unknown', reason: 'unsupported_legacy_state' });
    }
  }

  for (const field of ['minutes', 'goals', 'assists']) {
    if (Object.hasOwn(legacyRecord?.ratingInputs || {}, field)) continue;
    if (typeof legacyRecord?.[field] !== 'number' || !Number.isFinite(legacyRecord[field])) continue;
    const canonicalField = FIELD_MAP[field];
    compareValue(facts, field, canonicalField, legacyRecord[field], values[canonicalField], fieldStates[canonicalField]);
  }

  const providerRating = legacyRecord?.providerRatings?.apiFootball?.value;
  if (providerRating !== null && providerRating !== undefined) {
    compareValue(facts, 'providerRatings.apiFootball.value', 'rating', providerRating, values.rating, fieldStates.rating);
  }
  const appearanceState = expectedAppearanceState(legacyRecord);
  if (appearanceState) {
    facts.compared += 1;
    if (appearanceState === canonical?.appearanceState) {
      facts.matched += 1;
    } else {
      facts.mismatches.push({
        legacyField: 'appearance/start/bench',
        canonicalField: 'appearanceState',
        kind: 'value_mismatch',
        legacy: appearanceState,
        canonical: canonical?.appearanceState || null,
        canonicalPresence: 'present',
      });
    }
  }

  facts.notCompared.sort((left, right) => left.legacyField.localeCompare(right.legacyField));
  if (facts.mismatches.length) facts.state = 'failed';
  else if (facts.compared > 0 && (facts.canonicalEnrichments.length
    || facts.notCompared.some(item => item.legacyState === 'value'))) facts.state = 'partial';
  else if (facts.compared > 0) facts.state = 'passed';
  return facts;
}

function loadCanonicalFacts(database, link) {
  const record = database.prepare(RECORD_SQL).get(link.playerRecordId) || null;
  if (!record
    || record.canonical_fixture_id !== link.canonicalFixtureId
    || record.canonical_player_id !== link.canonicalPlayerId
    || record.canonical_team_id !== link.canonicalTeamId
    || record.revision_no !== link.publishedRevision) return null;
  const fieldStates = Object.fromEntries(database.prepare(FIELD_STATES_SQL)
    .all(record.fixture_revision_id, record.canonical_player_id)
    .map(state => [state.field_path, state.presence]));
  const values = Object.fromEntries([
    ...new Set([...Object.values(FIELD_MAP), 'rating']),
  ].map(field => [field, record[field]]));
  return {
    appearanceState: record.appearance_state,
    hasPlayerStats: Boolean(record.has_player_stats),
    values,
    fieldStates,
  };
}

function verifyFixtureRecordParity(database, snapshot, manifest) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('A node:sqlite DatabaseSync instance is required.');
  }
  const snapshotErrors = validateFixedSnapshot(snapshot);
  if (snapshotErrors.length) throw new Error(`Invalid fixed snapshot:\n- ${snapshotErrors.join('\n- ')}`);
  const manifestErrors = validateCoverageManifest(manifest);
  if (manifestErrors.length) throw new Error(`Invalid fixture coverage manifest:\n- ${manifestErrors.join('\n- ')}`);
  if (manifest.snapshot?.artifactSha256 !== artifactSha256(snapshot)) {
    throw new Error('Fixture coverage manifest does not belong to the supplied fixed snapshot.');
  }
  const next = structuredClone(manifest);
  const sourceRecords = new Map(snapshot.data.playerMatchStats.map(record => [record.recordId, record]));

  for (const record of next.records) {
    if (record.recordLink?.state !== 'linked') continue;
    const sourceRecord = sourceRecords.get(record.recordId);
    if (!sourceRecord) throw new Error(`Linked coverage record is absent from fixed snapshot: ${record.recordId}`);
    const canonical = loadCanonicalFacts(database, record.recordLink);
    if (!canonical) {
      delete record.factParity;
      record.reason = 'canonical_record_link_stale';
      continue;
    }
    record.factParity = compareLegacyRecordFacts(sourceRecord, canonical);
    record.importState = 'deferred';
    record.reason = record.factParity.state === 'passed'
      ? 'canonical_record_parity_verified_tracking_crosswalk_pending'
      : (record.factParity.state === 'failed'
        ? 'canonical_record_fact_parity_mismatch'
        : (record.factParity.state === 'partial'
          ? 'canonical_record_fact_parity_partial'
          : 'canonical_record_no_comparable_facts'));
  }

  const recordsByFixture = new Map();
  for (const record of next.records) {
    if (!record.canonicalFixtureId) continue;
    const records = recordsByFixture.get(record.canonicalFixtureId) || [];
    records.push(record);
    recordsByFixture.set(record.canonicalFixtureId, records);
  }
  for (const fixture of next.fixtures) {
    if (fixture.recordLinkage?.state !== 'complete') continue;
    const records = recordsByFixture.get(fixture.canonicalFixtureId) || [];
    const passed = records.filter(record => record.factParity?.state === 'passed').length;
    fixture.factParity = {
      state: passed === records.length && records.length > 0 ? 'complete' : 'incomplete',
      passedRecords: passed,
      totalRecords: records.length,
    };
    fixture.reason = fixture.factParity.state === 'complete'
      ? 'canonical_fact_parity_complete_tracking_crosswalk_pending'
      : 'canonical_fact_parity_incomplete';
  }

  next.summary.factParityPassedRecords = next.records
    .filter(record => record.factParity?.state === 'passed').length;
  next.summary.factParityFailedRecords = next.records
    .filter(record => record.factParity?.state === 'failed').length;
  next.summary.factParityPartialRecords = next.records
    .filter(record => record.factParity?.state === 'partial').length;
  next.summary.factParityNotComparableRecords = next.records
    .filter(record => record.factParity?.state === 'not_comparable').length;
  next.summary.factParityCompleteFixtures = next.fixtures
    .filter(fixture => fixture.factParity?.state === 'complete').length;
  next.summary.factParityGatePassed = next.summary.recordLinkedRecords > 0
    && next.summary.factParityPassedRecords === next.summary.recordLinkedRecords;
  next.summary.reasons = reasonCounts(next.records);
  next.summary.productionReadyRecords = 0;
  next.productionReady = false;

  const outputErrors = validateCoverageManifest(next);
  if (outputErrors.length) throw new Error(`Parity fixture coverage manifest is invalid:\n- ${outputErrors.join('\n- ')}`);
  return next;
}

module.exports = {
  FIELD_MAP,
  FIELD_STATES_SQL,
  RECORD_SQL,
  compareLegacyRecordFacts,
  verifyFixtureRecordParity,
};
