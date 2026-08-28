'use strict';

const { artifactSha256, validateFixedSnapshot } = require('./fixed-snapshot');

const COVERAGE_SCHEMA_VERSION = 'd1-fixture-coverage/1';

function providerFixtureId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function matchIndex(snapshot) {
  const index = new Map();
  for (const collection of ['matches', 'topMatches']) {
    for (const match of snapshot.data[collection] || []) {
      if (!match?.matchId) continue;
      const entries = index.get(match.matchId) || [];
      entries.push({
        fixtureId: providerFixtureId(match.providerIds?.apiFootball?.fixture),
        source: `data.${collection}`,
      });
      index.set(match.matchId, entries);
    }
  }
  return index;
}

function fixtureEvidence(record, matches) {
  const evidence = [];
  const direct = providerFixtureId(record.providerIds?.apiFootball?.fixture);
  if (direct) evidence.push({ fixtureId: direct, source: 'data.playerMatchStats' });
  for (const candidate of matches.get(record.matchId) || []) {
    if (candidate.fixtureId) evidence.push(candidate);
  }
  return evidence;
}

function uniqueFixtureIds(evidence) {
  return [...new Set(evidence.map(item => item.fixtureId))].sort((left, right) => left - right);
}

function classifyRecord(record, matches) {
  const evidence = fixtureEvidence(record, matches);
  const fixtureIds = uniqueFixtureIds(evidence);
  const base = {
    recordId: record.recordId,
    playerId: record.playerId,
    legacyMatchId: record.matchId || null,
    providerFixtureId: fixtureIds.length === 1 ? fixtureIds[0] : null,
    canonicalFixtureId: fixtureIds.length === 1 ? `af:fixture:${fixtureIds[0]}` : null,
    evidence,
  };

  if (!record.matchId) {
    return { ...base, coverageState: 'blocked', importState: 'deferred', reason: 'missing_legacy_match_id' };
  }
  if (fixtureIds.length === 0) {
    return { ...base, coverageState: 'blocked', importState: 'deferred', reason: 'missing_provider_fixture_id' };
  }
  if (fixtureIds.length > 1) {
    return {
      ...base,
      conflictingProviderFixtureIds: fixtureIds,
      coverageState: 'blocked',
      importState: 'deferred',
      reason: 'conflicting_provider_fixture_ids',
    };
  }
  return {
    ...base,
    coverageState: 'provider_fixture_verified',
    importState: 'deferred',
    reason: 'canonical_bundle_not_available',
  };
}

function fixtureGroups(records) {
  const grouped = new Map();
  for (const record of records) {
    if (record.coverageState !== 'provider_fixture_verified') continue;
    const existing = grouped.get(record.providerFixtureId) || {
      providerFixtureId: record.providerFixtureId,
      canonicalFixtureId: record.canonicalFixtureId,
      legacyMatchIds: new Set(),
      recordIds: [],
      importState: 'deferred',
      reason: 'canonical_bundle_not_available',
    };
    existing.legacyMatchIds.add(record.legacyMatchId);
    existing.recordIds.push(record.recordId);
    grouped.set(record.providerFixtureId, existing);
  }
  return [...grouped.values()]
    .sort((left, right) => left.providerFixtureId - right.providerFixtureId)
    .map(group => ({
      ...group,
      legacyMatchIds: [...group.legacyMatchIds].sort(),
      recordIds: group.recordIds.sort(),
    }));
}

function reasonCounts(records) {
  const counts = {};
  for (const record of records) counts[record.reason] = (counts[record.reason] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function validateCoverageManifest(manifest) {
  const errors = [];
  const records = manifest?.records || [];
  const summary = manifest?.summary || {};
  if (manifest?.schemaVersion !== COVERAGE_SCHEMA_VERSION) errors.push('unsupported coverage schemaVersion');
  if (!Array.isArray(manifest?.records)) errors.push('records must be an array');
  if (!Array.isArray(manifest?.fixtures)) errors.push('fixtures must be an array');
  if (new Set(records.map(record => record.recordId)).size !== records.length) errors.push('recordId coverage is not unique');
  if (records.some(record => record.importState !== 'deferred')) errors.push('coverage manifest must fail closed until canonical bundles are supplied');
  if (summary.legacyMatchRecords !== records.length) errors.push('summary legacyMatchRecords does not match records');
  if (summary.productionReadyRecords !== 0) errors.push('productionReadyRecords must remain zero without canonical bundles');
  if (manifest?.productionReady !== false) errors.push('productionReady must be false while all records are deferred');
  return errors;
}

function buildFixtureCoverageManifest(snapshot) {
  const snapshotErrors = validateFixedSnapshot(snapshot);
  if (snapshotErrors.length) throw new Error(`Invalid fixed snapshot:\n- ${snapshotErrors.join('\n- ')}`);

  const matches = matchIndex(snapshot);
  const records = snapshot.data.playerMatchStats
    .map(record => classifyRecord(record, matches))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  const fixtures = fixtureGroups(records);
  const verifiedRecords = records.filter(record => record.coverageState === 'provider_fixture_verified').length;
  const manifest = {
    schemaVersion: COVERAGE_SCHEMA_VERSION,
    snapshot: {
      schemaVersion: snapshot.schemaVersion,
      artifactSha256: artifactSha256(snapshot),
      inputSha256: snapshot.inputSha256,
      seasonId: snapshot.season.id,
      createdAt: snapshot.createdAt,
    },
    productionReady: false,
    summary: {
      legacyMatchRecords: records.length,
      providerFixtureVerifiedRecords: verifiedRecords,
      blockedRecords: records.length - verifiedRecords,
      uniqueProviderFixtures: fixtures.length,
      productionReadyRecords: 0,
      reasons: reasonCounts(records),
    },
    fixtures,
    records,
  };
  const errors = validateCoverageManifest(manifest);
  if (errors.length) throw new Error(`Invalid fixture coverage manifest:\n- ${errors.join('\n- ')}`);
  return manifest;
}

module.exports = {
  COVERAGE_SCHEMA_VERSION,
  buildFixtureCoverageManifest,
  validateCoverageManifest,
};
