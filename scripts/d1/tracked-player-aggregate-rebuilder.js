'use strict';

const { artifactSha256, sha256, stableStringify, validateFixedSnapshot } = require('./fixed-snapshot');
const { aggregatePayload } = require('./fixed-snapshot-importer');
const { validateCoverageManifest } = require('./fixture-coverage');
const { linkFixtureRecords } = require('./fixture-record-linkage');
const { verifyFixtureRecordParity } = require('./fixture-record-parity');
const { linkageBaseline } = require('./tracked-player-crosswalk-plan');

const AGGREGATE_REPORT_SCHEMA_VERSION = 'd1-tracked-player-aggregate-rebuild-report/1';
const AGGREGATE_VERIFY_REPORT_SCHEMA_VERSION = 'd1-tracked-player-aggregate-verify-report/1';
const AGGREGATE_SCHEMA_VERSION = 'd1-tracked-player-aggregate/1';
const NON_OFFICIAL_RE = /friendly|pre[- ]?season|親善|プレシーズン/i;
const OPEN_ENDED_DATE = '9999-12-31';
const AGG_FIELDS = Object.freeze([
  'apps', 'starts', 'minutes', 'goals', 'assists', 'cleanSheets', 'yellowCards',
  'secondYellowRed', 'straightRed', 'shots', 'shotsOnTarget', 'keyPasses', 'tackles',
  'interceptions', 'clearances', 'blocks', 'saves', 'duelsWon', 'duelsTotal',
  'aerialDuelsWon', 'aerialDuelsTotal', 'dribbles', 'dribbledPast', 'bigChancesMissed',
  'possessionsLost', 'passesCompleted', 'passesAttempted', 'shotsOnTargetFaced',
  'penaltiesSaved', 'penaltiesConceded', 'ownGoals', 'highClaims',
  'errorsLeadingToGoal', 'gaOnPitch',
]);

const CANONICAL_FIELDS = Object.freeze({
  minutes: 'minutes',
  goals: 'goals',
  assists: 'assists',
  yellowCards: 'yellow_cards',
  shots: 'shots',
  shotsOnTarget: 'shots_on_target',
  keyPasses: 'key_passes',
  tackles: 'tackles',
  interceptions: 'interceptions',
  blocks: 'blocks',
  saves: 'saves',
  duelsWon: 'duels_won',
  duelsTotal: 'duels',
  dribbles: 'dribbles',
  dribbledPast: 'dribbled_past',
  passesAttempted: 'passes',
  penaltiesSaved: 'penalties_saved',
  penaltiesConceded: 'penalties_conceded',
  gaOnPitch: 'goals_conceded',
});

const CANONICAL_RECORD_SQL = `
SELECT
  record.id AS player_record_id,
  record.team_id,
  fixture.competition_season_id,
  season.product_season_id,
  fixture.canonical_id AS canonical_fixture_id,
  fixture.date_jst,
  revision.revision_no,
  player.canonical_id AS canonical_player_id,
  team.canonical_id AS canonical_team_id,
  season.canonical_id AS competition_season_canonical_id,
  appearance.appearance_state,
  stats.minutes,
  stats.goals,
  stats.assists,
  stats.goals_conceded,
  stats.saves,
  stats.shots,
  stats.shots_on_target,
  stats.passes,
  stats.key_passes,
  stats.tackles,
  stats.blocks,
  stats.interceptions,
  stats.duels,
  stats.duels_won,
  stats.dribbles,
  stats.dribbled_past,
  stats.yellow_cards,
  stats.penalties_conceded,
  stats.penalties_saved,
  EXISTS (
    SELECT 1
    FROM tracking_periods period
    JOIN player_team_memberships membership ON membership.id = period.core_membership_id
    JOIN tracked_players tracked
      ON tracked.jfw_player_id = period.jfw_player_id
      AND tracked.player_id = membership.player_id
      AND tracked.crosswalk_state = 'resolved'
    WHERE period.jfw_player_id = ?2
      AND membership.player_id = record.player_id
      AND membership.team_id = record.team_id
      AND period.competition_season_id = fixture.competition_season_id
      AND period.tracking_status = 'active'
      AND fixture.date_jst >= period.valid_from
      AND (period.valid_to = '${OPEN_ENDED_DATE}' OR fixture.date_jst < period.valid_to)
  ) AS tracked_period_matches
FROM fixture_player_records record
JOIN fixtures fixture ON fixture.id = record.fixture_id
JOIN fixture_revisions revision
  ON revision.id = fixture.published_revision
  AND revision.fixture_id = fixture.id
  AND revision.lifecycle_state = 'published'
JOIN players player ON player.id = record.player_id
JOIN teams team ON team.id = record.team_id
JOIN competition_seasons season ON season.id = fixture.competition_season_id
JOIN tracked_players tracked
  ON tracked.player_id = record.player_id
  AND tracked.jfw_player_id = ?2
  AND tracked.crosswalk_state = 'resolved'
JOIN fixture_player_appearances appearance
  ON appearance.player_record_id = record.id
  AND appearance.fixture_revision_id = revision.id
LEFT JOIN fixture_player_stats stats ON stats.player_appearance_id = appearance.id
WHERE record.id = ?1`;

function row(database, sql, ...params) {
  return database.prepare(sql).get(...params) || null;
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

function timeKey(value) {
  const match = String(value || '').match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?/);
  return match ? match[0].replace('T', ' ') : '';
}

function dateKey(value) {
  return timeKey(value).slice(0, 10) || null;
}

function sourceRecordOfficial(record) {
  const competition = String(record?.competition || record?.league || '');
  return Boolean(competition)
    && !NON_OFFICIAL_RE.test(competition)
    && !NON_OFFICIAL_RE.test(String(record?.round || ''));
}

function sourceRecordValue(record, field) {
  if (field === 'apps') {
    if (record?.appearance === true || String(record?.appearance || '').startsWith('starter')
      || String(record?.appearance || '').startsWith('sub_')) return 1;
    if (record?.appearance === false || String(record?.appearance || '').includes('bench_unused')
      || String(record?.appearance || '').includes('absent')) return 0;
    return null;
  }
  if (field === 'starts') {
    if (record?.start === true || String(record?.appearance || '').startsWith('starter')) return 1;
    if (record?.start === false || String(record?.appearance || '').startsWith('sub_')
      || String(record?.appearance || '').includes('bench_unused')) return 0;
    return null;
  }
  if (record?.ratingInputs?.[field]?.state === 'value') return Number(record.ratingInputs[field].value);
  if (record?.[field] !== undefined && record?.[field] !== null
    && Number.isFinite(Number(record[field]))) return Number(record[field]);
  return null;
}

function canonicalRecordValue(record, field) {
  if (field === 'apps') {
    if (record.appearance_state === 'started' || record.appearance_state === 'substitute_used') return 1;
    if (record.appearance_state === 'bench_unused' || record.appearance_state === 'absent_confirmed') return 0;
    return null;
  }
  if (field === 'starts') {
    if (record.appearance_state === 'started') return 1;
    if (record.appearance_state === 'substitute_used' || record.appearance_state === 'bench_unused') return 0;
    return null;
  }
  const column = CANONICAL_FIELDS[field];
  return column && typeof record[column] === 'number' && Number.isFinite(record[column])
    ? record[column]
    : null;
}

function bucket() {
  return { hasData: false, known: {}, values: {} };
}

function addValues(target, values) {
  target.hasData = true;
  for (const field of AGG_FIELDS) {
    const value = values[field];
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      target.known[field] = false;
    } else if (target.known[field] !== false) {
      target.known[field] = true;
      target.values[field] = Number(target.values[field] || 0) + Number(value);
    }
  }
}

function finalizedBucket(target) {
  if (!target?.hasData) return {};
  return Object.fromEntries(AGG_FIELDS.flatMap(field => {
    if (target.known[field] === false) return [[field, null]];
    if (target.known[field] === true) return [[field, Number(target.values[field] || 0)]];
    return [];
  }));
}

function scopeKey(scope, competitionSeasonId = null, teamId = null) {
  return `${scope}:${competitionSeasonId ?? '-'}:${teamId ?? '-'}`;
}

function scopeIdentity(scope, competitionSeasonId = null, teamId = null) {
  return { scope, competitionSeasonId, teamId, key: scopeKey(scope, competitionSeasonId, teamId) };
}

function recordScopes(competitionSeasonId, teamId) {
  return [
    scopeIdentity('season'),
    scopeIdentity('competition', competitionSeasonId),
    scopeIdentity('club', null, teamId),
    scopeIdentity('club_competition', competitionSeasonId, teamId),
  ];
}

function addToScopes(scopes, identities, values) {
  for (const identity of identities) {
    let current = scopes.get(identity.key);
    if (!current) {
      current = { ...identity, bucket: bucket(), baselineCount: 0, recordIds: [] };
      scopes.set(identity.key, current);
    }
    addValues(current.bucket, values);
  }
}

function activeCorePeriods(database, jfwPlayerId, productSeasonId) {
  return database.prepare(`SELECT
      period.valid_from, period.valid_to, period.competition_season_id,
      membership.team_id, team.canonical_id AS team_canonical_id,
      season.canonical_id AS competition_season_canonical_id
    FROM tracking_periods period
    JOIN player_team_memberships membership ON membership.id = period.core_membership_id
    JOIN teams team ON team.id = membership.team_id
    JOIN competition_seasons season ON season.id = period.competition_season_id
    WHERE period.jfw_player_id = ?1
      AND period.tracking_status = 'active'
      AND season.product_season_id = ?2
    ORDER BY period.valid_from, period.valid_to, period.id`).all(jfwPlayerId, productSeasonId);
}

function baselineSegments(database, snapshot, player, productSeasonId) {
  const periods = activeCorePeriods(database, player.playerId, productSeasonId);
  const memberships = player.membershipHistory || [];
  const segments = [];
  for (const baseline of Object.values(player._aggregateBaselines || {})) {
    const baselineDate = dateKey(baseline.updated);
    const candidates = memberships.filter(membership => {
      const validFrom = membership.from || snapshot.season.startsOn;
      const validTo = membership.to || OPEN_ENDED_DATE;
      return membership.tracked !== false
        && membership.club === baseline.club
        && membership.league === baseline.competition
        && (!baselineDate || (baselineDate >= validFrom
          && (validTo === OPEN_ENDED_DATE || baselineDate < validTo)));
    });
    if (candidates.length !== 1) {
      throw new Error('aggregate_baseline_membership_not_exact');
    }
    const membership = candidates[0];
    const validFrom = membership.from || snapshot.season.startsOn;
    const validTo = membership.to || OPEN_ENDED_DATE;
    const matches = periods.filter(period => period.valid_from === validFrom && period.valid_to === validTo);
    if (matches.length !== 1) throw new Error('aggregate_baseline_core_period_not_exact');
    segments.push({
      baseline,
      competitionSeasonId: matches[0].competition_season_id,
      competitionSeasonCanonicalId: matches[0].competition_season_canonical_id,
      teamId: matches[0].team_id,
      teamCanonicalId: matches[0].team_canonical_id,
    });
  }
  return segments;
}

function recordCoveredByBaseline(record, baselines) {
  const baseline = baselines.find(item => item.baseline.club === record.club
    && item.baseline.competition === String(record.competition || record.league || ''));
  const recordTime = timeKey(record.ko);
  const baselineTime = timeKey(baseline?.baseline.updated);
  return Boolean(baseline && recordTime && baselineTime && recordTime <= baselineTime);
}

function canonicalRecord(database, coverageRecord, sourceRecord, productSeasonId) {
  const link = coverageRecord.recordLink;
  const record = row(database, CANONICAL_RECORD_SQL, link.playerRecordId, sourceRecord.playerId);
  if (!record
    || !record.tracked_period_matches
    || record.product_season_id !== productSeasonId
    || record.canonical_fixture_id !== link.canonicalFixtureId
    || record.canonical_player_id !== link.canonicalPlayerId
    || record.canonical_team_id !== link.canonicalTeamId
    || record.revision_no !== link.publishedRevision) return null;
  return record;
}

function buildPlayerAggregates(database, snapshot, player, coverageByRecord, productSeasonId) {
  const tracked = row(database, `SELECT crosswalk_state FROM tracked_players
    WHERE jfw_player_id = ?1`, player.playerId);
  if (tracked?.crosswalk_state !== 'resolved') {
    return { state: 'deferred', reason: 'tracked_player_crosswalk_not_resolved' };
  }
  let baselines;
  try {
    baselines = baselineSegments(database, snapshot, player, productSeasonId);
  } catch (error) {
    return { state: 'deferred', reason: error.message };
  }
  const expected = new Map();
  const actual = new Map();
  for (const segment of baselines) {
    const identities = recordScopes(segment.competitionSeasonId, segment.teamId);
    addToScopes(expected, identities, segment.baseline.stats || {});
    addToScopes(actual, identities, segment.baseline.stats || {});
    for (const identity of identities) {
      expected.get(identity.key).baselineCount += 1;
      actual.get(identity.key).baselineCount += 1;
    }
  }

  const sourceRecords = snapshot.data.playerMatchStats
    .filter(record => record.playerId === player.playerId
      && record.trackedAtMatch === true && sourceRecordOfficial(record))
    .sort((left, right) => String(left.recordId).localeCompare(String(right.recordId)));
  for (const sourceRecord of sourceRecords) {
    if (recordCoveredByBaseline(sourceRecord, baselines)) continue;
    const coverageRecord = coverageByRecord.get(sourceRecord.recordId);
    if (coverageRecord?.recordLink?.state !== 'linked') {
      return { state: 'deferred', reason: 'canonical_record_not_linked', recordId: sourceRecord.recordId };
    }
    if (coverageRecord.factParity?.state !== 'passed') {
      return { state: 'deferred', reason: 'canonical_fact_parity_not_passed', recordId: sourceRecord.recordId };
    }
    const canonical = canonicalRecord(database, coverageRecord, sourceRecord, productSeasonId);
    if (!canonical) {
      return { state: 'deferred', reason: 'canonical_tracking_scope_not_matched', recordId: sourceRecord.recordId };
    }
    const identities = recordScopes(canonical.competition_season_id, canonical.team_id);
    const sourceValues = Object.fromEntries(AGG_FIELDS.map(field => [field, sourceRecordValue(sourceRecord, field)]));
    const canonicalValues = Object.fromEntries(AGG_FIELDS.map(field => [field, canonicalRecordValue(canonical, field)]));
    addToScopes(expected, identities, sourceValues);
    addToScopes(actual, identities, canonicalValues);
    for (const identity of identities) {
      expected.get(identity.key).recordIds.push(sourceRecord.recordId);
      actual.get(identity.key).recordIds.push(sourceRecord.recordId);
    }
  }

  if (!actual.has(scopeKey('season'))) {
    const identity = scopeIdentity('season');
    actual.set(identity.key, { ...identity, bucket: bucket(), baselineCount: 0, recordIds: [] });
    expected.set(identity.key, { ...identity, bucket: bucket(), baselineCount: 0, recordIds: [] });
  }
  const legacySeasonStats = player.seasonStats || player.stats || {};
  const expectedSeasonStats = finalizedBucket(expected.get(scopeKey('season')).bucket);
  if (stableStringify(expectedSeasonStats) !== stableStringify(legacySeasonStats)) {
    return { state: 'failed', reason: 'legacy_season_aggregate_parity_mismatch',
      scope: scopeKey('season'), expected: legacySeasonStats, actual: expectedSeasonStats };
  }
  const actualKeys = [...actual.keys()].sort();
  const expectedKeys = [...expected.keys()].sort();
  if (stableStringify(actualKeys) !== stableStringify(expectedKeys)) {
    return { state: 'failed', reason: 'aggregate_scope_parity_mismatch' };
  }
  const aggregates = [];
  for (const key of actualKeys) {
    const actualScope = actual.get(key);
    const expectedStats = finalizedBucket(expected.get(key).bucket);
    const stats = finalizedBucket(actualScope.bucket);
    if (stableStringify(stats) !== stableStringify(expectedStats)) {
      return { state: 'failed', reason: 'aggregate_stats_parity_mismatch', scope: key,
        expected: expectedStats, actual: stats };
    }
    aggregates.push({
      scope: actualScope.scope,
      competitionSeasonId: actualScope.competitionSeasonId,
      teamId: actualScope.teamId,
      stats,
      baselineCount: actualScope.baselineCount,
      recordIds: [...actualScope.recordIds].sort(),
    });
  }
  return { state: 'ready', aggregates };
}

function aggregatePayloadForStorage(database, productSeasonCanonicalId, aggregate) {
  const competitionSeason = aggregate.competitionSeasonId === null ? null
    : row(database, 'SELECT canonical_id FROM competition_seasons WHERE id = ?1', aggregate.competitionSeasonId);
  const team = aggregate.teamId === null ? null
    : row(database, 'SELECT canonical_id FROM teams WHERE id = ?1', aggregate.teamId);
  return {
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
    scope: {
      aggregateScope: aggregate.scope,
      productSeasonCanonicalId,
      competitionSeasonCanonicalId: competitionSeason?.canonical_id || null,
      teamCanonicalId: team?.canonical_id || null,
    },
    stats: aggregate.stats,
    provenance: {
      confirmedBaselineSegments: aggregate.baselineCount,
      canonicalRecordIds: aggregate.recordIds,
    },
  };
}

function storedAggregate(database, jfwPlayerId, productSeasonId, aggregate) {
  return row(database, `SELECT id, stats_json, source_hash, rebuilt_at
    FROM tracked_player_aggregates
    WHERE jfw_player_id = ?1 AND product_season_id = ?2 AND aggregate_scope = ?3
      AND COALESCE(competition_season_id, -1) = COALESCE(?4, -1)
      AND COALESCE(team_id, -1) = COALESCE(?5, -1)`,
  jfwPlayerId, productSeasonId, aggregate.scope, aggregate.competitionSeasonId, aggregate.teamId);
}

function legacySeasonHash(snapshotHash, player) {
  const stats = aggregatePayload(player);
  return sha256({ inputSha256: snapshotHash, playerId: player.playerId, stats });
}

function expectedStoredAggregate(database, snapshot, player, productSeason, aggregate, snapshotHash) {
  const payload = aggregatePayloadForStorage(database, productSeason.canonical_id, aggregate);
  const statsJson = stableStringify(payload);
  return {
    statsJson,
    sourceHash: sha256({ snapshotHash, jfwPlayerId: player.playerId,
      productSeasonCanonicalId: productSeason.canonical_id, statsJson }),
    rebuiltAt: snapshot.createdAt,
  };
}

function writePlayerAggregates(database, snapshot, player, productSeason, aggregates, snapshotHash) {
  return transaction(database, () => {
    const expectedIdentities = new Set(aggregates.map(aggregate => scopeKey(
      aggregate.scope, aggregate.competitionSeasonId, aggregate.teamId,
    )));
    const existingRows = database.prepare(`SELECT aggregate_scope, competition_season_id, team_id
      FROM tracked_player_aggregates
      WHERE jfw_player_id = ?1 AND product_season_id = ?2`).all(player.playerId, productSeason.id);
    const unexpected = existingRows.find(existing => !expectedIdentities.has(scopeKey(
      existing.aggregate_scope, existing.competition_season_id, existing.team_id,
    )));
    if (unexpected) throw new Error(`aggregate_unexpected_existing_scope:${unexpected.aggregate_scope}`);
    let changed = false;
    for (const aggregate of aggregates) {
      const expected = expectedStoredAggregate(database, snapshot, player,
        productSeason, aggregate, snapshotHash);
      const { statsJson, sourceHash, rebuiltAt } = expected;
      const existing = storedAggregate(database, player.playerId, productSeason.id, aggregate);
      if (existing && existing.source_hash === sourceHash && existing.stats_json === statsJson
        && existing.rebuilt_at === rebuiltAt) continue;
      const replaceableLegacy = aggregate.scope === 'season'
        && aggregate.competitionSeasonId === null && aggregate.teamId === null
        && existing?.source_hash === legacySeasonHash(snapshotHash, player)
        && existing?.stats_json === JSON.stringify(aggregatePayload(player));
      if (existing && !replaceableLegacy) throw new Error(`aggregate_conflicts_with_existing_row:${aggregate.scope}`);
      if (existing) {
        database.prepare(`UPDATE tracked_player_aggregates
          SET stats_json = ?1, source_hash = ?2, rebuilt_at = ?3 WHERE id = ?4`)
          .run(statsJson, sourceHash, rebuiltAt, existing.id);
      } else {
        database.prepare(`INSERT INTO tracked_player_aggregates(
          jfw_player_id, product_season_id, competition_season_id, team_id,
          aggregate_scope, stats_json, source_hash, rebuilt_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
          .run(player.playerId, productSeason.id, aggregate.competitionSeasonId, aggregate.teamId,
            aggregate.scope, statsJson, sourceHash, rebuiltAt);
      }
      const stored = storedAggregate(database, player.playerId, productSeason.id, aggregate);
      if (!stored || stored.stats_json !== statsJson || stored.source_hash !== sourceHash
        || stored.rebuilt_at !== rebuiltAt) throw new Error('aggregate_failed_roundtrip_validation');
      changed = true;
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('aggregate rebuild failed foreign key validation');
    }
    return changed ? 'rebuilt' : 'already_rebuilt';
  });
}

function rebuildTrackedPlayerAggregates(database, snapshot, coverage) {
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
  const productSeason = row(database, `SELECT id, canonical_id FROM product_seasons
    WHERE canonical_id = ?1`, `jfw:season:${snapshot.season.id}`);
  if (!productSeason) throw new Error('Fixed snapshot product season is absent from D1.');
  const verifiedCoverage = verifyFixtureRecordParity(database, snapshot,
    linkFixtureRecords(database, snapshot, linkageBaseline(coverage)));
  const coverageByRecord = new Map(verifiedCoverage.records.map(record => [record.recordId, record]));
  const results = [];
  let expectedRows = 0;

  for (const player of [...snapshot.data.players]
    .sort((left, right) => left.playerId.localeCompare(right.playerId))) {
    const built = buildPlayerAggregates(database, snapshot, player, coverageByRecord, productSeason.id);
    if (built.state !== 'ready') {
      results.push({ jfwPlayerId: player.playerId,
        status: built.state, reason: built.reason, recordId: built.recordId || null,
        scope: built.scope || null, expected: built.expected, actual: built.actual });
      continue;
    }
    expectedRows += built.aggregates.length;
    try {
      const status = writePlayerAggregates(database, snapshot, player, productSeason,
        built.aggregates, snapshotHash);
      results.push({ jfwPlayerId: player.playerId, status,
        aggregateRows: built.aggregates.length });
    } catch (error) {
      results.push({ jfwPlayerId: player.playerId, status: 'failed', reason: error.message });
    }
  }

  const count = status => results.filter(result => result.status === status).length;
  const acceptedPlayers = count('rebuilt') + count('already_rebuilt');
  const storedRows = row(database, `SELECT COUNT(*) AS count FROM tracked_player_aggregates
    WHERE product_season_id = ?1`, productSeason.id).count;
  return {
    schemaVersion: AGGREGATE_REPORT_SCHEMA_VERSION,
    snapshot: { artifactSha256: snapshotHash, inputSha256: snapshot.inputSha256,
      seasonId: snapshot.season.id },
    productionReady: false,
    summary: {
      trackedPlayers: results.length,
      rebuiltPlayers: count('rebuilt'),
      alreadyRebuiltPlayers: count('already_rebuilt'),
      deferredPlayers: count('deferred'),
      failedPlayers: count('failed'),
      acceptedPlayers,
      expectedAggregateRows: expectedRows,
      storedAggregateRows: storedRows,
      aggregateParityGatePassed: results.length > 0
        && acceptedPlayers === results.length
        && count('deferred') === 0
        && count('failed') === 0
        && storedRows === expectedRows,
    },
    players: results,
  };
}

function verifyTrackedPlayerAggregates(database, snapshot, coverage, options = {}) {
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
  const productSeason = row(database, `SELECT id, canonical_id FROM product_seasons
    WHERE canonical_id = ?1`, `jfw:season:${snapshot.season.id}`);
  if (!productSeason) throw new Error('Fixed snapshot product season is absent from D1.');
  const verifiedCoverage = options.verifiedCoverage || verifyFixtureRecordParity(database, snapshot,
    linkFixtureRecords(database, snapshot, linkageBaseline(coverage)));
  const coverageByRecord = new Map(verifiedCoverage.records.map(record => [record.recordId, record]));
  const expectedPlayerIds = options.expectedPlayerIds || null;
  const results = [];
  let expectedRows = 0;

  for (const player of [...snapshot.data.players]
    .sort((left, right) => left.playerId.localeCompare(right.playerId))) {
    if (expectedPlayerIds && !expectedPlayerIds.has(player.playerId)) {
      results.push({ jfwPlayerId: player.playerId, status: 'not_applicable',
        reason: 'outside_phase2_expected_scope' });
      continue;
    }
    const built = buildPlayerAggregates(database, snapshot, player, coverageByRecord, productSeason.id);
    if (built.state !== 'ready') {
      results.push({ jfwPlayerId: player.playerId, status: built.state, reason: built.reason,
        recordId: built.recordId || null, scope: built.scope || null });
      continue;
    }
    expectedRows += built.aggregates.length;
    const expectedIdentities = new Set(built.aggregates.map(aggregate => scopeKey(
      aggregate.scope, aggregate.competitionSeasonId, aggregate.teamId,
    )));
    const existingRows = database.prepare(`SELECT aggregate_scope, competition_season_id, team_id
      FROM tracked_player_aggregates
      WHERE jfw_player_id = ?1 AND product_season_id = ?2`).all(player.playerId, productSeason.id);
    const unexpected = existingRows.find(existing => !expectedIdentities.has(scopeKey(
      existing.aggregate_scope, existing.competition_season_id, existing.team_id,
    )));
    if (existingRows.length !== built.aggregates.length || unexpected) {
      results.push({ jfwPlayerId: player.playerId, status: 'failed',
        reason: 'stored_aggregate_scope_set_mismatch' });
      continue;
    }
    let mismatch = null;
    for (const aggregate of built.aggregates) {
      const expected = expectedStoredAggregate(database, snapshot, player,
        productSeason, aggregate, snapshotHash);
      const stored = storedAggregate(database, player.playerId, productSeason.id, aggregate);
      if (!stored) {
        mismatch = `expected_aggregate_not_stored:${aggregate.scope}`;
        break;
      }
      if (stored.stats_json !== expected.statsJson || stored.source_hash !== expected.sourceHash
        || stored.rebuilt_at !== expected.rebuiltAt) {
        mismatch = `stored_aggregate_does_not_match_fixed_snapshot:${aggregate.scope}`;
        break;
      }
    }
    results.push(mismatch
      ? { jfwPlayerId: player.playerId, status: 'failed', reason: mismatch }
      : { jfwPlayerId: player.playerId, status: 'verified',
        aggregateRows: built.aggregates.length });
  }

  const count = status => results.filter(result => result.status === status).length;
  const expectedPlayers = expectedPlayerIds ? expectedPlayerIds.size
    : results.length - count('not_applicable');
  const storedRows = expectedPlayerIds
    ? database.prepare(`SELECT jfw_player_id FROM tracked_player_aggregates
        WHERE product_season_id = ?1`).all(productSeason.id)
      .filter(item => expectedPlayerIds.has(item.jfw_player_id)).length
    : row(database, `SELECT COUNT(*) AS count FROM tracked_player_aggregates
        WHERE product_season_id = ?1`, productSeason.id).count;
  return {
    schemaVersion: AGGREGATE_VERIFY_REPORT_SCHEMA_VERSION,
    snapshot: { artifactSha256: snapshotHash, inputSha256: snapshot.inputSha256,
      seasonId: snapshot.season.id },
    productionReady: false,
    summary: {
      snapshotPlayers: results.length,
      expectedPlayers,
      verifiedPlayers: count('verified'),
      notApplicablePlayers: count('not_applicable'),
      deferredPlayers: count('deferred'),
      failedPlayers: count('failed'),
      expectedAggregateRows: expectedRows,
      storedAggregateRows: storedRows,
      aggregateParityGatePassed: expectedPlayers > 0
        && count('verified') === expectedPlayers
        && count('deferred') === 0
        && count('failed') === 0
        && storedRows === expectedRows,
    },
    players: results,
  };
}

module.exports = {
  AGG_FIELDS,
  AGGREGATE_REPORT_SCHEMA_VERSION,
  AGGREGATE_SCHEMA_VERSION,
  AGGREGATE_VERIFY_REPORT_SCHEMA_VERSION,
  CANONICAL_RECORD_SQL,
  addValues,
  baselineSegments,
  buildPlayerAggregates,
  canonicalRecordValue,
  finalizedBucket,
  expectedStoredAggregate,
  rebuildTrackedPlayerAggregates,
  sourceRecordOfficial,
  sourceRecordValue,
  verifyTrackedPlayerAggregates,
};
