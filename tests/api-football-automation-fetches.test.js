'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { executeAutomationFetches } = require('../scripts/v2/execute-api-football-automation-fetches');

function plan() {
  return {
    schemaVersion: 'jfw-api-football-automation-plan/1', mode: 'preview',
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

function client(status = 'FT') {
  const calls = [];
  return {
    calls,
    async get(endpoint) {
      calls.push(endpoint);
      let response = [];
      if (endpoint === 'fixtures') {
        response = [{
          fixture: { id: 9001, date: '2026-09-17T12:00:00Z', status: { short: status } },
          league: { id: 39, season: 2026, name: 'Premier League' },
          teams: { home: { id: 40, name: 'Home' }, away: { id: 50, name: 'Away' } },
          goals: { home: 1, away: 0 }, score: {},
        }];
      } else if (endpoint === 'standings') {
        response = [{ league: { id: 39, season: 2026, name: 'Premier League', standings: [[]] } }];
      }
      return { data: { response }, quota: { dailyRemaining: 7000 - calls.length } };
    },
  };
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-automation-fetches-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('automation fetch executor completes and validates every artifact before publishing', async t => {
  const root = workspace(t);
  const fake = client();
  const result = await executeAutomationFetches({
    plan: plan(), outputRoot: root, client: fake,
    now: () => new Date('2026-09-17T16:00:00Z'),
  });
  assert.deepEqual(fake.calls, [
    'fixtures', 'fixtures/events', 'fixtures/lineups', 'fixtures/players',
    'fixtures/statistics', 'standings',
  ]);
  assert.equal(result.fixtureCount, 1);
  assert.equal(result.standingsCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(root, 'fixtures', '9001', 'fixture.json'), 'utf8',
  )).fixture.ingestionState, 'finalized');
  assert.ok(fs.existsSync(path.join(root, 'standings', '39-2026', 'manifest.json')));
});

test('automation fetch executor rejects a fixture that regresses from final status', async t => {
  await assert.rejects(() => executeAutomationFetches({
    plan: plan(), outputRoot: workspace(t), client: client('2H'),
  }), /not the planned finalized identity/);
});

test('automation fetch executor refuses disabled or malformed plans before any API call', async t => {
  const fake = client();
  await assert.rejects(() => executeAutomationFetches({
    plan: { ...plan(), mode: 'disabled' }, outputRoot: workspace(t), client: fake,
  }), /invalid or disabled/);
  assert.deepEqual(fake.calls, []);
});
