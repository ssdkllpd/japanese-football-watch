'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function prepared() {
  const artifact = key => ({ r2Key: key, sha256: 'a'.repeat(64) });
  return {
    source: { provider: 'api-football', archiveSha256: 'b'.repeat(64) },
    requests: [
      { operation: 'major_league_core_publish', artifactKey: 'core' },
      { operation: 'major_league_standings_publish', artifactKey: 'core' },
      { operation: 'fixture_migration_publish', fixtureId: 'af:fixture:1', artifactKey: 'fixture-1' },
      { operation: 'fixture_migration_publish', fixtureId: 'af:fixture:2', artifactKey: 'fixture-2' },
      { operation: 'major_league_date_coverage_publish', artifactKey: 'coverage' },
      { operation: 'migration_verify', fixtureIds: ['af:fixture:1', 'af:fixture:2'] },
    ],
    uploadObjects: [artifact('core'), artifact('fixture-1'), artifact('fixture-2'), artifact('coverage')],
    summary: {
      coreFixtures: 2, fixtureDetails: 2, adminRequests: 6, uploadObjects: 4,
    },
  };
}

function resumeState(overrides = {}) {
  return {
    schemaVersion: 'jfw-d1-major-league-partial-state/1',
    state: 'compatible-partial', passed: true,
    expectedFixtures: 2, expectedDetails: 2,
    storedFixtures: 2, matchedDetails: 1,
    pendingFixtures: 0, pendingDetails: 1, pendingUpgrades: 0,
    matchedFixtureDetailIds: ['af:fixture:1'],
    pendingFixtureDetailIds: ['af:fixture:2'],
    ...overrides,
  };
}

test('resume plan skips only independently matched fixture writes and their R2 objects', async () => {
  const { applyResumeState, validationResult } = await import('../scripts/d1/migrate-major-league-snapshot.mjs');
  const result = applyResumeState(prepared(), resumeState());

  assert.deepEqual(result.requests.map(item => [item.operation, item.fixtureId || null]), [
    ['major_league_core_publish', null],
    ['major_league_standings_publish', null],
    ['fixture_migration_publish', 'af:fixture:2'],
    ['major_league_date_coverage_publish', null],
    ['migration_verify', null],
  ]);
  assert.deepEqual(result.uploadObjects.map(item => item.r2Key), ['core', 'fixture-2', 'coverage']);
  assert.deepEqual(result.requests.at(-1).fixtureIds, ['af:fixture:1', 'af:fixture:2']);
  assert.deepEqual(result.resume, {
    schemaVersion: 'jfw-d1-major-league-partial-state/1',
    state: 'compatible-partial', passed: true,
    matchedFixtureDetails: 1, pendingFixtureDetails: 1,
  });
  assert.equal(result.summary.authoritativeAdminRequests, 6);
  assert.equal(result.summary.adminRequests, 5);
  assert.equal(result.summary.authoritativeUploadObjects, 4);
  assert.equal(result.summary.uploadObjects, 3);
  assert.equal(result.summary.skippedFixtureDetails, 1);
  assert.equal(validationResult(result).passed, true);
  result.summary.authoritativeAdminRequests += 1;
  assert.equal(validationResult(result).checks.requestPlanCountValid, false);
});

test('resume plan fails closed on stale, duplicate, unsorted, or incomplete fixture partitions', async () => {
  const { applyResumeState } = await import('../scripts/d1/migrate-major-league-snapshot.mjs');
  for (const state of [
    resumeState({ schemaVersion: 'wrong' }),
    resumeState({ passed: false }),
    resumeState({ matchedFixtureDetailIds: ['af:fixture:1', 'af:fixture:1'], matchedDetails: 2 }),
    resumeState({ pendingFixtureDetailIds: ['af:fixture:999'] }),
    resumeState({ pendingFixtureDetailIds: [], pendingDetails: 0 }),
    resumeState({ expectedFixtures: 3 }),
    resumeState({ state: 'complete' }),
    resumeState({ unexpected: true }),
  ]) assert.throws(() => applyResumeState(prepared(), state));

  const missingArtifact = prepared();
  missingArtifact.uploadObjects = missingArtifact.uploadObjects
    .filter(item => item.r2Key !== 'fixture-2');
  assert.throws(
    () => applyResumeState(missingArtifact, resumeState()),
    /cannot resolve every required/,
  );
});
