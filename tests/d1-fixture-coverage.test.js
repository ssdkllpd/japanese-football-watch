'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  buildFixtureCoverageManifest,
  reconcileCanonicalFixtureImports,
  validateCoverageManifest,
} = require('../scripts/d1/fixture-coverage');
const { buildFixedSnapshot, currentSnapshotInputs, stableStringify } = require('../scripts/d1/fixed-snapshot');

function sampleSnapshot() {
  return buildFixedSnapshot({
    baseData: {
      updated: '2026-08-27T00:00:00.000Z',
      players: [{
        playerId: 'jp:one',
        name: 'One',
        club: 'Home FC',
        league: 'Premier League',
        seasonStats: { apps: 2, goals: 0 },
      }],
      matches: [{
        matchId: 'match:verified',
        providerIds: { apiFootball: { fixture: 9001 } },
      }],
      playerMatchStats: [],
    },
    basePath: 'data.json',
    fragments: [{
      playerMatchStats: [
        { recordId: 'record:verified', playerId: 'jp:one', matchId: 'match:verified', values: { goals: 0 } },
        { recordId: 'record:missing', playerId: 'jp:one', matchId: 'match:missing', values: { goals: null } },
      ],
    }],
    fragmentNames: ['data/test.json'],
    createdAt: '2026-08-27T12:00:00.000Z',
    season: { id: '2026-27', label: '2026-27', startsOn: '2026-07-01', endsOn: '2027-06-30' },
  });
}

test('coverage fails closed and distinguishes verified fixture IDs from missing IDs', () => {
  const manifest = buildFixtureCoverageManifest(sampleSnapshot());

  assert.equal(manifest.productionReady, false);
  assert.deepEqual(manifest.summary, {
    legacyMatchRecords: 2,
    providerFixtureVerifiedRecords: 1,
    blockedRecords: 1,
    uniqueProviderFixtures: 1,
    productionReadyRecords: 0,
    reasons: {
      canonical_bundle_not_available: 1,
      missing_provider_fixture_id: 1,
    },
  });
  assert.equal(manifest.records.find(record => record.recordId === 'record:verified').canonicalFixtureId, 'af:fixture:9001');
  assert.equal(manifest.records.find(record => record.recordId === 'record:verified').importState, 'deferred');
  assert.equal(manifest.records.find(record => record.recordId === 'record:missing').providerFixtureId, null);
  assert.deepEqual(validateCoverageManifest(manifest), []);
});

test('conflicting fixture evidence is blocked instead of choosing one ID', () => {
  const snapshot = sampleSnapshot();
  const record = snapshot.data.playerMatchStats.find(item => item.recordId === 'record:verified');
  record.providerIds = { apiFootball: { fixture: 9002 } };
  const { sha256 } = require('../scripts/d1/fixed-snapshot');
  const { inputSha256: ignored, ...payload } = snapshot;
  snapshot.inputSha256 = sha256(payload);

  const manifest = buildFixtureCoverageManifest(snapshot);
  const conflict = manifest.records.find(item => item.recordId === 'record:verified');

  assert.equal(conflict.coverageState, 'blocked');
  assert.equal(conflict.reason, 'conflicting_provider_fixture_ids');
  assert.deepEqual(conflict.conflictingProviderFixtureIds, [9001, 9002]);
  assert.equal(manifest.summary.uniqueProviderFixtures, 0);
});

test('current fixed input accounts for every legacy record without making any production-ready', () => {
  const inputs = currentSnapshotInputs(path.join(__dirname, '..'));
  const snapshot = buildFixedSnapshot({
    ...inputs,
    createdAt: '2026-08-27T12:00:00.000Z',
    season: { id: inputs.seasonId, label: inputs.seasonId, startsOn: '2026-07-01', endsOn: '2027-06-30' },
  });

  const manifest = buildFixtureCoverageManifest(snapshot);

  assert.equal(manifest.summary.legacyMatchRecords, 118);
  assert.equal(manifest.summary.providerFixtureVerifiedRecords, 61);
  assert.equal(manifest.summary.blockedRecords, 57);
  assert.equal(manifest.summary.uniqueProviderFixtures, 27);
  assert.equal(manifest.summary.productionReadyRecords, 0);
  assert.equal(manifest.records.length, 118);
  assert.equal(new Set(manifest.records.map(record => record.recordId)).size, 118);
});

test('CLI writes a deterministic canonical manifest for an exact fixed snapshot', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-fixture-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'snapshot.json');
  const first = path.join(directory, 'first.json');
  const second = path.join(directory, 'second.json');
  fs.writeFileSync(input, stableStringify(sampleSnapshot()));

  for (const output of [first, second]) {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'd1', 'create-fixture-coverage-manifest.js'),
      '--input', input,
      '--output', output,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }

  assert.equal(fs.readFileSync(first, 'utf8'), fs.readFileSync(second, 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(first, 'utf8')).summary.legacyMatchRecords, 2);
});

test('import registry separates available bundles from pending record linkage without opening the production gate', () => {
  const coverage = buildFixtureCoverageManifest(sampleSnapshot());
  const reconciled = reconcileCanonicalFixtureImports(coverage, {
    schemaVersion: 'd1-canonical-fixture-import-report/1',
    fixtures: [{
      fixtureId: 'af:fixture:9001',
      status: 'imported',
      contentSha256: 'a'.repeat(64),
    }],
  });

  const imported = reconciled.records.find(record => record.recordId === 'record:verified');
  const blocked = reconciled.records.find(record => record.recordId === 'record:missing');
  assert.equal(reconciled.productionReady, false);
  assert.equal(reconciled.summary.productionReadyRecords, 0);
  assert.equal(reconciled.summary.canonicalBundleImportedFixtures, 1);
  assert.equal(reconciled.summary.canonicalBundleImportedRecords, 1);
  assert.equal(imported.importState, 'deferred');
  assert.equal(imported.reason, 'canonical_bundle_imported_record_linkage_pending');
  assert.equal(imported.canonicalBundle.contentSha256, 'a'.repeat(64));
  assert.equal(blocked.reason, 'missing_provider_fixture_id');
  assert.deepEqual(validateCoverageManifest(reconciled), []);
});

test('coverage reconciliation rejects imported fixtures outside the fixed snapshot', () => {
  const coverage = buildFixtureCoverageManifest(sampleSnapshot());
  assert.throws(() => reconcileCanonicalFixtureImports(coverage, {
    schemaVersion: 'd1-canonical-fixture-import-report/1',
    fixtures: [{
      fixtureId: 'af:fixture:9999',
      status: 'imported',
      contentSha256: 'b'.repeat(64),
    }],
  }), /outside the coverage manifest/);
});
