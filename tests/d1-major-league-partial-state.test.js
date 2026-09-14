'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function preparedDirectory(t, revision = 1, previousContentSha256 = '1'.repeat(64)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-partial-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseFixture = {
    id: 'af:fixture:1', revision, competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
  };
  const bundle = {
    contractVersion: '2.1.0', detailAvailability: 'available', fixture: baseFixture,
    events: [], lineups: [], playerStats: [], teamStats: [], sectionStates: {},
  };
  writeJson(path.join(root, 'core.json'), {
    fixtures: [{ fixtureId: 'af:fixture:1' }, { fixtureId: 'af:fixture:2' }],
  });
  writeJson(path.join(root, 'fixture.json'), { bundle });
  writeJson(path.join(root, 'migration-manifest.json'), {
    fixtureRevisionOverrides: revision === 1 ? [] : [{
      fixtureId: 'af:fixture:1', previousRevision: revision - 1,
      previousContentSha256, migrationRevision: revision,
    }],
    leagues: [{
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
      coreArtifact: { path: 'core.json' },
      fixtureArtifacts: [{ fixtureId: 'af:fixture:1', path: 'fixture.json' }],
    }],
  });
  return root;
}

test('partial-state detector accepts clean, resumable, and complete databases', async t => {
  const { detectPartialState, expectedState } = await import('../scripts/d1/check-major-league-partial-state.mjs');
  const prepared = preparedDirectory(t);
  assert.deepEqual(detectPartialState(prepared, [{ results: [] }]), {
    state: 'clean', passed: true, expectedFixtures: 2, expectedDetails: 1,
    storedFixtures: 0, matchedDetails: 0, pendingFixtures: 2,
    pendingDetails: 1, pendingUpgrades: 0,
  });

  const expected = expectedState(prepared);
  const detail = expected.details.get('af:fixture:1');
  const completeRows = [{
    fixture_id: 'af:fixture:1', competition_id: 'af:competition:39', season_id: 'af:season:39:2026',
    revision_no: 1, lifecycle_state: 'published', content_sha256: detail.contentSha256, is_published: 1,
  }, {
    fixture_id: 'af:fixture:2', competition_id: 'af:competition:39', season_id: 'af:season:39:2026',
    revision_no: null, lifecycle_state: null, content_sha256: null, is_published: 0,
  }];
  assert.equal(detectPartialState(prepared, [{ results: completeRows }]).state, 'complete');
  assert.deepEqual(detectPartialState(prepared, [{ results: completeRows.slice(0, 1) }]), {
    state: 'compatible-partial', passed: true, expectedFixtures: 2, expectedDetails: 1,
    storedFixtures: 1, matchedDetails: 1, pendingFixtures: 1,
    pendingDetails: 0, pendingUpgrades: 0,
  });
  assert.deepEqual(detectPartialState(prepared, [{ results: [completeRows[1]] }]), {
    state: 'compatible-partial', passed: true, expectedFixtures: 2, expectedDetails: 1,
    storedFixtures: 1, matchedDetails: 0, pendingFixtures: 1,
    pendingDetails: 1, pendingUpgrades: 0,
  });
  assert.throws(() => detectPartialState(prepared, [{ results: [{ ...completeRows[0], content_sha256: '0'.repeat(64) }, completeRows[1]] }]),
    /hash differs at the prepared revision/);
});

test('partial-state detector safely upgrades one reviewed revision and accepts its history', async t => {
  const { detectPartialState, expectedState } = await import('../scripts/d1/check-major-league-partial-state.mjs');
  const prepared = preparedDirectory(t, 2);
  const expected = expectedState(prepared);
  const detail = expected.details.get('af:fixture:1');
  const compact = {
    fixture_id: 'af:fixture:2', competition_id: 'af:competition:39', season_id: 'af:season:39:2026',
    revision_no: null, lifecycle_state: null, content_sha256: null, is_published: 0,
  };
  const old = {
    fixture_id: 'af:fixture:1', competition_id: 'af:competition:39', season_id: 'af:season:39:2026',
    revision_no: 1, lifecycle_state: 'published', content_sha256: '1'.repeat(64), is_published: 1,
  };
  assert.throws(() => detectPartialState(prepared, [{ results: [] }]),
    /Required previous fixture revisions are missing/);
  assert.throws(() => detectPartialState(prepared, [{ results: [compact] }]),
    /Required previous fixture revision is missing/);
  const resumable = detectPartialState(prepared, [{ results: [old, compact] }]);
  assert.equal(resumable.state, 'compatible-partial');
  assert.equal(resumable.pendingDetails, 1);
  assert.equal(resumable.pendingUpgrades, 1);

  const history = [{ ...old, lifecycle_state: 'superseded', is_published: 0 }, {
    ...old, revision_no: 2, content_sha256: detail.contentSha256,
  }, compact];
  assert.deepEqual(detectPartialState(prepared, [{ results: history }]), {
    state: 'complete', passed: true, expectedFixtures: 2, expectedDetails: 1,
    storedFixtures: 2, matchedDetails: 1, pendingFixtures: 0,
    pendingDetails: 0, pendingUpgrades: 0,
  });

  assert.throws(() => detectPartialState(prepared, [{ results: [
    { ...old, revision_no: 2 }, compact,
  ] }]), /hash differs at the prepared revision/);
  assert.throws(() => detectPartialState(prepared, [{ results: [
    { ...old, revision_no: 3 }, compact,
  ] }]), /newer than the prepared migration/);
  assert.throws(() => detectPartialState(prepared, [{ results: [
    { ...old, content_sha256: '9'.repeat(64) }, compact,
  ] }]), /cannot be upgraded directly/);
  assert.throws(() => detectPartialState(prepared, [{ results: [
    old, { ...old, content_sha256: '2'.repeat(64) }, compact,
  ] }]), /Invalid or duplicate revision history/);
  assert.throws(() => detectPartialState(prepared, [{ results: [
    old, { ...old, revision_no: 2, content_sha256: detail.contentSha256 }, compact,
  ] }]), /exactly one published revision/);
});

test('partial-state detector rejects unknown fixtures and scope mismatches', async t => {
  const { detectPartialState } = await import('../scripts/d1/check-major-league-partial-state.mjs');
  const prepared = preparedDirectory(t);
  const row = {
    fixture_id: 'af:fixture:999', competition_id: 'af:competition:39', season_id: 'af:season:39:2026',
    revision_no: null, lifecycle_state: null, content_sha256: null, is_published: 0,
  };
  assert.throws(() => detectPartialState(prepared, [{ results: [row] }]), /Unexpected fixture/);
  assert.throws(() => detectPartialState(prepared, [{ results: [{
    ...row, fixture_id: 'af:fixture:1', competition_id: 'af:competition:40',
  }] }]), /scope differs/);
});

test('partial-state SQL is derived from the prepared season inventory', async t => {
  const { partialStateQuery } = await import('../scripts/d1/check-major-league-partial-state.mjs');
  const sql = partialStateQuery(preparedDirectory(t));
  assert.match(sql, /af:season:39:2026/);
  assert.match(sql, /revision\.content_sha256/);
  assert.match(sql, /fixture\.published_revision = revision\.id/);
});
