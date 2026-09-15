'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sha256 } = require('../scripts/d1/fixed-snapshot');
const { normalizeFixtureBundle: normalizeForComparison } = require('../scripts/d1/fixture-shadow-compare');
const { normalizeFixtureBundle } = require('../scripts/v2/fixture-contract');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function preparedDirectory(t, revision = 1, previousContentSha256 = '1'.repeat(64)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-partial-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = normalizeFixtureBundle({
    fixture: {
      id: 1, date: '2026-09-01T18:00:00+00:00', referee: null,
      venue: { id: null, name: null, city: null },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
    },
    league: {
      id: 39, name: 'Premier League', country: 'England', logo: null, flag: null,
      season: 2026, round: 'Regular Season - 1',
    },
    teams: {
      home: { id: 40, name: 'Home FC', logo: null, winner: true },
      away: { id: 50, name: 'Away FC', logo: null, winner: false },
    },
    goals: { home: 2, away: 0 },
    score: {
      halftime: { home: 1, away: 0 }, fulltime: { home: 2, away: 0 },
      extratime: { home: null, away: null }, penalty: { home: null, away: null },
    },
    events: [], lineups: [], players: [],
    statistics: [{
      team: { id: 40, name: 'Home FC', logo: null },
      statistics: [{ type: 'Total Shots', value: null }],
    }],
  }, { fetchedAt: '2026-09-08T02:15:09.068Z' });
  bundle.fixture.revision = revision;
  writeJson(path.join(root, 'core.json'), {
    source: { apiVersion: 'v3' },
    productSeason: { id: 'jfw:season:2026-27' },
    competition: { type: 'League', countryCode: 'GB' },
    season: {
      status: 'current', startsOn: '2026-08-21', endsOn: '2027-05-30', finalizedOn: null,
    },
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

test('partial-state hash uses the same provider reconciliation as the admin Worker', async t => {
  const { expectedState } = await import('../scripts/d1/check-major-league-partial-state.mjs');
  const prepared = preparedDirectory(t);
  const artifact = JSON.parse(fs.readFileSync(path.join(prepared, 'fixture.json'), 'utf8'));
  const unreconciledHash = sha256(normalizeForComparison(artifact.bundle));
  const expectedHash = expectedState(prepared).details.get('af:fixture:1').contentSha256;
  const reconciled = structuredClone(artifact.bundle);
  delete reconciled.teamStats[0].values.total_shots;

  assert.notEqual(expectedHash, unreconciledHash);
  assert.equal(expectedHash, sha256(normalizeForComparison(reconciled)));
});

test('partial-state detector accepts clean, resumable, and complete databases', async t => {
  const { detectPartialState, expectedState } = await import('../scripts/d1/check-major-league-partial-state.mjs');
  const prepared = preparedDirectory(t);
  assert.deepEqual(detectPartialState(prepared, [{ results: [] }]), {
    schemaVersion: 'jfw-d1-major-league-partial-state/1',
    state: 'clean', passed: true, expectedFixtures: 2, expectedDetails: 1,
    storedFixtures: 0, matchedDetails: 0, pendingFixtures: 2,
    pendingDetails: 1, pendingUpgrades: 0,
    matchedFixtureDetailIds: [], pendingFixtureDetailIds: ['af:fixture:1'],
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
    schemaVersion: 'jfw-d1-major-league-partial-state/1',
    state: 'compatible-partial', passed: true, expectedFixtures: 2, expectedDetails: 1,
    storedFixtures: 1, matchedDetails: 1, pendingFixtures: 1,
    pendingDetails: 0, pendingUpgrades: 0,
    matchedFixtureDetailIds: ['af:fixture:1'], pendingFixtureDetailIds: [],
  });
  assert.deepEqual(detectPartialState(prepared, [{ results: [completeRows[1]] }]), {
    schemaVersion: 'jfw-d1-major-league-partial-state/1',
    state: 'compatible-partial', passed: true, expectedFixtures: 2, expectedDetails: 1,
    storedFixtures: 1, matchedDetails: 0, pendingFixtures: 1,
    pendingDetails: 1, pendingUpgrades: 0,
    matchedFixtureDetailIds: [], pendingFixtureDetailIds: ['af:fixture:1'],
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
    schemaVersion: 'jfw-d1-major-league-partial-state/1',
    state: 'complete', passed: true, expectedFixtures: 2, expectedDetails: 1,
    storedFixtures: 2, matchedDetails: 1, pendingFixtures: 0,
    pendingDetails: 0, pendingUpgrades: 0,
    matchedFixtureDetailIds: ['af:fixture:1'], pendingFixtureDetailIds: [],
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
