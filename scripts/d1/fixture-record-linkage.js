'use strict';

const { artifactSha256, validateFixedSnapshot } = require('./fixed-snapshot');
const { reasonCounts, validateCoverageManifest } = require('./fixture-coverage');

const LINK_METHOD = 'provider_fixture_player_id';

const FIXTURE_SQL = `
SELECT
  fixture.id AS fixture_row_id,
  fixture.published_revision,
  revision.revision_no,
  revision.content_sha256
FROM fixtures fixture
JOIN fixture_revisions revision
  ON revision.id = fixture.published_revision
  AND revision.fixture_id = fixture.id
  AND revision.lifecycle_state = 'published'
WHERE fixture.canonical_id = ?1`;

const PLAYER_RECORD_SQL = `
SELECT
  record.id AS player_record_id,
  player.canonical_id AS canonical_player_id,
  player.provider_id AS provider_player_id,
  team.canonical_id AS canonical_team_id,
  team.provider_id AS provider_team_id,
  appearance.appearance_state,
  appearance.id AS appearance_id,
  stats.player_appearance_id IS NOT NULL AS has_player_stats
FROM fixture_player_records record
JOIN players player ON player.id = record.player_id
JOIN provider_sources source ON source.id = player.source_id AND source.code = 'api-football'
JOIN teams team ON team.id = record.team_id
LEFT JOIN fixture_player_appearances appearance
  ON appearance.player_record_id = record.id
  AND appearance.fixture_revision_id = ?2
LEFT JOIN fixture_player_stats stats ON stats.player_appearance_id = appearance.id
WHERE record.fixture_id = ?1
  AND player.provider_id = ?3`;

function positiveProviderId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function snapshotRecordIndex(snapshot) {
  return new Map((snapshot.data.playerMatchStats || []).map(record => [record.recordId, record]));
}

function fixtureHeader(database, canonicalFixtureId) {
  return database.prepare(FIXTURE_SQL).get(canonicalFixtureId) || null;
}

function candidatePlayerRecords(database, fixture, providerPlayerId) {
  return database.prepare(PLAYER_RECORD_SQL)
    .all(fixture.fixture_row_id, fixture.published_revision, providerPlayerId);
}

function setPending(record, reason) {
  delete record.recordLink;
  record.importState = 'deferred';
  record.reason = reason;
}

function linkFixtureRecords(database, snapshot, manifest) {
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
  const sourceRecords = snapshotRecordIndex(snapshot);
  if (sourceRecords.size !== next.records.length
    || next.records.some(record => !sourceRecords.has(record.recordId))) {
    throw new Error('Fixture coverage records do not exactly match the fixed snapshot.');
  }

  const linkKeyCounts = new Map();
  for (const record of next.records) {
    if (record.canonicalBundle?.state !== 'imported') continue;
    const providerPlayerId = positiveProviderId(sourceRecords.get(record.recordId)
      ?.providerIds?.apiFootball?.player);
    if (!providerPlayerId) continue;
    const key = `${record.canonicalFixtureId}:${providerPlayerId}`;
    linkKeyCounts.set(key, (linkKeyCounts.get(key) || 0) + 1);
  }

  const headers = new Map();
  for (const record of next.records) {
    if (record.canonicalBundle?.state !== 'imported') continue;
    const sourceRecord = sourceRecords.get(record.recordId);
    const providerPlayerId = positiveProviderId(sourceRecord.providerIds?.apiFootball?.player);
    if (!providerPlayerId) {
      setPending(record, 'canonical_provider_player_id_missing');
      continue;
    }
    if (linkKeyCounts.get(`${record.canonicalFixtureId}:${providerPlayerId}`) > 1) {
      setPending(record, 'duplicate_legacy_fixture_player_records');
      continue;
    }

    let fixture = headers.get(record.canonicalFixtureId);
    if (fixture === undefined) {
      fixture = fixtureHeader(database, record.canonicalFixtureId);
      headers.set(record.canonicalFixtureId, fixture);
    }
    if (!fixture || fixture.content_sha256 !== record.canonicalBundle.contentSha256) {
      setPending(record, 'canonical_published_bundle_mismatch');
      continue;
    }

    const candidates = candidatePlayerRecords(database, fixture, providerPlayerId);
    if (candidates.length === 0) {
      setPending(record, 'canonical_player_record_missing');
      continue;
    }
    if (candidates.length > 1) {
      setPending(record, 'canonical_player_record_ambiguous');
      continue;
    }
    const candidate = candidates[0];
    const providerTeamId = positiveProviderId(sourceRecord.providerIds?.apiFootball?.team);
    if (providerTeamId && candidate.provider_team_id !== providerTeamId) {
      setPending(record, 'canonical_player_team_mismatch');
      continue;
    }
    if (!candidate.appearance_id) {
      setPending(record, 'canonical_published_appearance_missing');
      continue;
    }

    record.recordLink = {
      state: 'linked',
      method: LINK_METHOD,
      canonicalFixtureId: record.canonicalFixtureId,
      canonicalPlayerId: candidate.canonical_player_id,
      canonicalTeamId: candidate.canonical_team_id,
      providerPlayerId,
      providerTeamId: candidate.provider_team_id,
      playerRecordId: candidate.player_record_id,
      publishedRevision: fixture.revision_no,
      appearanceState: candidate.appearance_state,
      hasPlayerStats: Boolean(candidate.has_player_stats),
    };
    record.importState = 'deferred';
    record.reason = 'canonical_record_linked_fact_parity_pending';
  }

  const recordsByFixture = new Map();
  for (const record of next.records) {
    if (!record.canonicalFixtureId) continue;
    const records = recordsByFixture.get(record.canonicalFixtureId) || [];
    records.push(record);
    recordsByFixture.set(record.canonicalFixtureId, records);
  }
  for (const fixture of next.fixtures) {
    if (fixture.canonicalBundle?.state !== 'imported') continue;
    const records = recordsByFixture.get(fixture.canonicalFixtureId) || [];
    const linked = records.filter(record => record.recordLink?.state === 'linked').length;
    fixture.recordLinkage = {
      state: linked === records.length && records.length > 0 ? 'complete' : 'incomplete',
      linkedRecords: linked,
      totalRecords: records.length,
    };
    fixture.reason = fixture.recordLinkage.state === 'complete'
      ? 'canonical_record_linkage_complete_fact_parity_pending'
      : 'canonical_record_linkage_incomplete';
  }

  const importedRecords = next.records.filter(record => record.canonicalBundle?.state === 'imported');
  next.summary.recordLinkedRecords = next.records
    .filter(record => record.recordLink?.state === 'linked').length;
  next.summary.recordLinkPendingRecords = importedRecords.length - next.summary.recordLinkedRecords;
  next.summary.recordLinkCompleteFixtures = next.fixtures
    .filter(fixture => fixture.recordLinkage?.state === 'complete').length;
  next.summary.reasons = reasonCounts(next.records);
  next.summary.productionReadyRecords = 0;
  next.productionReady = false;

  const outputErrors = validateCoverageManifest(next);
  if (outputErrors.length) throw new Error(`Linked fixture coverage manifest is invalid:\n- ${outputErrors.join('\n- ')}`);
  return next;
}

module.exports = {
  FIXTURE_SQL,
  LINK_METHOD,
  PLAYER_RECORD_SQL,
  linkFixtureRecords,
};
