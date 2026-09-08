'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  RequestBudget,
  collectSnapshot,
  parseTargets,
} = require('../scripts/v2/fetch-major-league-season-snapshot');

function providerResult(endpoint, params, remaining) {
  let response;
  let paging = { current: 1, total: 1 };
  if (endpoint === 'leagues') response = [{ league: { id: 39, name: 'Premier League' } }];
  else if (endpoint === 'standings') response = [{ league: { standings: [[{ rank: 1 }, { rank: 2 }]] } }];
  else if (endpoint === 'teams') response = [
    { team: { id: 40, name: 'Home' } },
    { team: { id: 50, name: 'Away' } },
  ];
  else if (endpoint === 'fixtures' && params.league) response = [
    { fixture: { id: 9001, status: { short: 'FT' } } },
    { fixture: { id: 9002, status: { short: 'NS' } } },
  ];
  else if (endpoint === 'fixtures') response = [{
    fixture: { id: 9001, status: { short: 'FT' } },
    events: [],
  }];
  else if (endpoint === 'players') {
    response = [{ player: { id: params.page === 1 ? 1 : 2 } }];
    paging = { current: params.page, total: 2 };
  } else if (endpoint === 'players/squads') response = [{ players: [{ id: params.team * 10 }] }];
  else if (endpoint === 'coachs') response = [{ id: params.team * 100 }];
  else if (endpoint === 'teams/statistics') response = { team: { id: params.team } };
  else response = [];
  return {
    data: { response, paging },
    quota: { dailyLimit: 7500, dailyRemaining: remaining, minuteLimit: 300, minuteRemaining: 299 },
  };
}

test('parseTargets rejects mismatched competition and season namespaces', () => {
  assert.throws(() => parseTargets({
    schemaVersion: 'jfw-d1-admin-ingest-plan/1',
    standings: [{ competitionId: 'af:competition:39', seasonId: 'af:season:40:2026' }],
  }), /Invalid competition\/season target/);
});

test('major-league snapshot collects core, roster, aggregate and completed-fixture detail data', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-major-leagues-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const client = {
    async get(endpoint, params) {
      calls.push([endpoint, params]);
      return providerResult(endpoint, params, 7500 - calls.length);
    },
  };
  let clock = 0;
  const budget = new RequestBudget({
    reserve: 50,
    minimumIntervalMs: 0,
    wait: async () => {},
    now: () => ++clock,
  });
  const manifest = await collectSnapshot({
    client,
    budget,
    config: {
      schemaVersion: 'jfw-d1-admin-ingest-plan/1',
      standings: [{ competitionId: 'af:competition:39', seasonId: 'af:season:39:2026' }],
    },
    outputRoot: directory,
    startedAt: '2026-09-08T00:00:00.000Z',
    completedAt: '2026-09-08T00:01:00.000Z',
  });

  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.totals, {
    teams: 2,
    fixtures: 2,
    completedFixtures: 1,
    completedFixtureDetails: 1,
    standingsRows: 2,
    playerRows: 2,
    uniquePlayersByLeague: 2,
    squadPlayers: 2,
    coaches: 2,
  });
  assert.equal(manifest.quota.requestsUsed, 16);
  assert.ok(fs.existsSync(path.join(directory, 'league-39', 'completed-fixtures', '9001.json')));
  assert.ok(fs.existsSync(path.join(directory, 'league-39', 'players', 'page-2.json')));
  assert.equal(calls.filter(([endpoint]) => endpoint === 'fixtures/events').length, 0);
  assert.equal(calls.filter(([endpoint]) => endpoint === 'fixtures/lineups').length, 1);
  assert.equal(calls.filter(([endpoint]) => endpoint === 'fixtures/players').length, 1);
  assert.equal(calls.filter(([endpoint]) => endpoint === 'fixtures/statistics').length, 1);
});

test('request budget refuses a new request after the protected reserve is reached', async () => {
  let calls = 0;
  const budget = new RequestBudget({ minimumIntervalMs: 0, reserve: 50, now: () => calls });
  const client = {
    async get() {
      calls += 1;
      return { data: { response: [] }, quota: { dailyRemaining: 50 } };
    },
  };
  await budget.get(client, 'countries', {});
  await assert.rejects(budget.get(client, 'countries', {}), /daily reserve reached/);
  assert.equal(calls, 1);
});
