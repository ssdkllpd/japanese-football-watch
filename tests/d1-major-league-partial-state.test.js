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

function preparedDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-partial-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseFixture = {
    id: 'af:fixture:1', revision: 1, competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
  };
  const bundle = {
    contractVersion: '2.1.0', detailAvailability: 'available', fixture: baseFixture,
    events: [], lineups: [], playerStats: [], teamStats: [], sectionStates: {},
  };
  writeJson(path.join(root, 'core.json'), {
    fixtures: [{ fixtureId: 'af:fixture:1' }, { fixtureId: 'af:fixture:2' }],
  });
  writeJson(path.join(root, 'fixture.json'), { bundle });
  writeJson(path.join(root, 'migration-manifest.json'), { leagues: [{
    competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
    coreArtifact: { path: 'core.json' },
    fixtureArtifacts: [{ fixtureId: 'af:fixture:1', path: 'fixture.json' }],
  }] });
  return root;
}

test('partial-state detector distinguishes clean, complete, and partial databases', async t => {
  const { detectPartialState, expectedState } = await import('../scripts/d1/check-major-league-partial-state.mjs');
  const prepared = preparedDirectory(t);
  assert.equal(detectPartialState(prepared, [{ results: [] }]).state, 'clean');

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
  assert.throws(() => detectPartialState(prepared, [{ results: completeRows.slice(0, 1) }]),
    /Partial migration fixture set detected/);
  assert.throws(() => detectPartialState(prepared, [{ results: [{ ...completeRows[0], content_sha256: '0'.repeat(64) }, completeRows[1]] }]),
    /revision\/hash\/publication differs/);
});

test('partial-state SQL is derived from the prepared season inventory', async t => {
  const { partialStateQuery } = await import('../scripts/d1/check-major-league-partial-state.mjs');
  const sql = partialStateQuery(preparedDirectory(t));
  assert.match(sql, /af:season:39:2026/);
  assert.match(sql, /revision\.content_sha256/);
  assert.match(sql, /fixture\.published_revision = revision\.id/);
});
