'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAutomationAdminPlan } = require('../scripts/d1/create-api-football-automation-admin-plan');
const { normalizeStandings, writeStandings } = require('../scripts/v2/fetch-standings');

function fixtureBundle() {
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

function automationPlan() {
  return {
    schemaVersion: 'jfw-api-football-automation-plan/1',
    detailFetches: [{
      providerFixtureId: 9001, fixtureId: 'af:fixture:9001',
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
    }],
    standingsFetches: [{
      league: 39, season: 2026,
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
    }],
  };
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-automation-admin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtureDir = path.join(root, 'fixtures', '9001');
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'fixture.json'), JSON.stringify(fixtureBundle()));
  fs.writeFileSync(path.join(fixtureDir, 'fixture-pointer.json'), JSON.stringify({
    fixtureId: 'af:fixture:9001',
    key: 'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/fixtures/af:fixture:9001.json',
  }));
  fs.writeFileSync(path.join(fixtureDir, 'date-index.json'), JSON.stringify({
    date: '2026-08-22', fixtures: [{ fixtureId: 'af:fixture:9001' }],
  }));
  fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), JSON.stringify({
    r2Objects: [
      {
        role: 'fixture', fixtureId: 'af:fixture:9001', file: 'fixture.json',
        key: 'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/fixtures/af:fixture:9001.json',
      },
      {
        role: 'fixture_pointer', file: 'fixture-pointer.json',
        key: 'football/v2/indexes/fixture/af:fixture:9001.json',
      },
      {
        role: 'date_index', file: 'date-index.json',
        key: 'football/v2/indexes/date-jst/2026-08-22.json',
        merge: 'date_index', mergeScope: 'generic', mergeMode: 'upsert',
      },
    ],
  }));
  const standingsDir = path.join(root, 'standings', '39-2026');
  const snapshot = normalizeStandings([{
    league: {
      id: 39, season: 2026, name: 'Premier League', country: 'England', standings: [[{
        rank: 1, team: { id: 40, name: 'Liverpool' }, group: 'Premier League', all: {},
      }]],
    },
  }], { league: 39, season: 2026, fetchedAt: '2026-08-22T02:00:00Z' });
  writeStandings(standingsDir, snapshot);
  return root;
}

test('automation admin plan binds fetched artifacts to the reviewed plan scopes', t => {
  const root = workspace(t);
  const plan = createAutomationAdminPlan(automationPlan(), root, root);
  assert.deepEqual(plan.fixtures.map(item => item.fixtureId), ['af:fixture:9001']);
  assert.deepEqual(plan.standings, [{
    competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
  }]);
  assert.deepEqual(plan.dateIndexCoverages, []);
  assert.equal(plan.expectedTotals, null);
  assert.ok(fs.existsSync(path.join(root, 'd1-corrections', 'af_fixture_9001.json')));
});

test('automation admin plan rejects fixture and standings scope drift', t => {
  const root = workspace(t);
  const fixtureDrift = automationPlan();
  fixtureDrift.detailFetches[0].competitionId = 'af:competition:78';
  assert.throws(() => createAutomationAdminPlan(fixtureDrift, root, root), /scope differs/);

  const standingsDrift = automationPlan();
  standingsDrift.standingsFetches[0].seasonId = 'af:season:39:2025';
  assert.throws(() => createAutomationAdminPlan(standingsDrift, root, root), /scope differs/);
});

test('automation admin plan rejects escaped and malformed publish artifacts', t => {
  const root = workspace(t);
  const manifestPath = path.join(root, 'standings', '39-2026', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.r2Objects[0].key = 'football/v2/wrong.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => createAutomationAdminPlan(automationPlan(), root, root), /standings_snapshot object is invalid/);
});

test('automation admin plan rejects a fixture pointer or date-index key drift', t => {
  const root = workspace(t);
  const manifestPath = path.join(root, 'fixtures', '9001', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.r2Objects.find(item => item.role === 'date_index').key = 'football/v2/indexes/date-jst/2026-08-23.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => createAutomationAdminPlan(automationPlan(), root, root), /publish manifest is invalid/);
});
