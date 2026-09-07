'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createV2AdminPlan } = require('../scripts/d1/create-v2-admin-plan');

function bundle() {
  return {
    contractVersion: '2.1.0', detailAvailability: 'available',
    fixture: {
      id: 'af:fixture:9001', providerId: 9001,
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
      kickoffUtc: '2026-08-21T20:00:00.000Z', dateJst: '2026-08-22', revision: 2,
      teams: { home: { id: 'af:team:40' }, away: { id: 'af:team:50' } },
    },
    overrides: {}, fieldIssues: {},
  };
}

function fixtureItem() {
  return {
    role: 'fixture', fixtureId: 'af:fixture:9001', file: 'fixtures/9001.json',
    key: 'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/fixtures/af:fixture:9001.json',
  };
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-v2-admin-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'fixtures'));
  fs.writeFileSync(path.join(root, 'fixtures', '9001.json'), JSON.stringify(bundle()));
  return root;
}

test('v2 admin plan derives fixture and full-date coverage scopes independently', t => {
  const root = workspace(t);
  const manifest = {
    date: '2026-08-22', query: { date: '2026-08-22', timezone: 'Asia/Tokyo' },
    r2Objects: [
      { role: 'date_index', file: 'date-index.json', key: 'football/v2/indexes/date-jst/2026-08-22.json' },
      {
        role: 'competition_date_index', competitionId: 'af:competition:39', file: 'competition.json',
        key: 'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
      },
      fixtureItem(),
    ],
  };
  const plan = createV2AdminPlan(manifest, root, root);
  assert.deepEqual(plan, {
    schemaVersion: 'jfw-d1-admin-ingest-plan/1',
    fixtures: [{
      fixtureId: 'af:fixture:9001', competitionId: 'af:competition:39',
      seasonId: 'af:season:39:2026', reuseStoredCatalog: true,
      correctionsPath: 'd1-corrections/af_fixture_9001.json',
    }],
    standings: [],
    dateIndexCoverages: [{ date: '2026-08-22', competitionIds: ['af:competition:39'] }],
    expectedTotals: null,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(root, 'd1-corrections', 'af_fixture_9001.json'), 'utf8',
  )), {
    schemaVersion: 'd1-fixture-correction-definitions/1',
    fixtureId: 'af:fixture:9001', definitions: [],
  });
});

test('league-scoped date updates publish fixtures without claiming complete date coverage', t => {
  const root = workspace(t);
  const plan = createV2AdminPlan({
    date: '2026-08-22', query: { date: '2026-08-22', league: '39' },
    r2Objects: [fixtureItem()],
  }, root, root);
  assert.equal(plan.fixtures.length, 1);
  assert.deepEqual(plan.dateIndexCoverages, []);
});

test('v2 admin plan rejects competition omission and unreviewed fixture corrections', t => {
  const root = workspace(t);
  const manifest = {
    date: '2026-08-22', query: { date: '2026-08-22' },
    r2Objects: [{ role: 'date_index' }, fixtureItem()],
  };
  assert.throws(() => createV2AdminPlan(manifest, root, root), /scope differs/);

  const corrected = bundle();
  corrected.overrides['fixture.score.goals.home'] = { status: 'active' };
  fs.writeFileSync(path.join(root, 'fixtures', '9001.json'), JSON.stringify(corrected));
  assert.throws(() => createV2AdminPlan({ r2Objects: [fixtureItem()] }, root, root),
    /reviewed Git correction definitions/);
});

test('v2 admin plan rejects date index keys that do not match the external date scope', t => {
  const root = workspace(t);
  const manifest = {
    date: '2026-08-22', query: { date: '2026-08-22' },
    r2Objects: [
      { role: 'date_index', key: 'football/v2/indexes/date-jst/2026-08-23.json' },
      {
        role: 'competition_date_index', competitionId: 'af:competition:39',
        key: 'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
      },
      fixtureItem(),
    ],
  };
  assert.throws(() => createV2AdminPlan(manifest, root, root), /Generic date index key differs/);
  assert.equal(fs.existsSync(path.join(root, 'd1-corrections')), false);
});
