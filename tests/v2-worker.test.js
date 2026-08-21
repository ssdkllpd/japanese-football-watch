'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadWorker() {
  return import('../worker/index.mjs');
}

test('live projection exposes only provider-independent DTO fields to the UI', async () => {
  const worker = await loadWorker();
  const payload = {
    response: [{
      fixture: {
        id: 123,
        date: '2026-08-21T20:00:00Z',
        status: { short: '2H', long: 'Second Half', elapsed: 63 },
        referee: 'must not leak into live DTO',
      },
      league: { id: 39, season: 2026, name: 'Premier League' },
      teams: {
        home: { id: 40, name: 'Home FC', logo: 'https://example.com/home.png' },
        away: { id: 50, name: 'Away FC', logo: 'https://example.com/away.png' },
      },
      goals: { home: 2, away: 1 },
      events: [{ shouldNotLeak: true }],
    }],
  };

  const dto = worker.projectLiveFixtures(payload, { LIVE_COMPETITION_IDS: '39' });
  assert.equal(dto.contractVersion, '2.0.0');
  assert.equal(dto.fixtures.length, 1);
  assert.deepEqual(dto.fixtures[0], {
    fixtureId: 'af:fixture:123',
    competitionId: 'af:competition:39',
    seasonId: 'af:season:39:2026',
    kickoffUtc: '2026-08-21T20:00:00.000Z',
    dateJst: '2026-08-22',
    status: { short: '2H', long: 'Second Half', elapsed: 63 },
    home: { teamId: 'af:team:40', name: 'Home FC', logo: 'https://example.com/home.png', score: 2 },
    away: { teamId: 'af:team:50', name: 'Away FC', logo: 'https://example.com/away.png', score: 1 },
  });
  assert.equal('events' in dto.fixtures[0], false);
  assert.equal('referee' in dto.fixtures[0], false);
});

test('live projection can be scoped by competition ID without name matching', async () => {
  const worker = await loadWorker();
  const rows = [
    { fixture: { id: 1 }, league: { id: 39, season: 2026 }, teams: {}, goals: {} },
    { fixture: { id: 2 }, league: { id: 140, season: 2026 }, teams: {}, goals: {} },
  ];
  const dto = worker.projectLiveFixtures(rows, { LIVE_COMPETITION_IDS: '140' });
  assert.deepEqual(dto.fixtures.map(row => row.fixtureId), ['af:fixture:2']);
});

test('origin allowlist is explicit and no-origin access requires an opt-in', async () => {
  const worker = await loadWorker();
  const env = { APP_ORIGINS: 'https://example.github.io,https://app.example.com' };
  assert.equal(worker.isAllowedOrigin('https://example.github.io', env), true);
  assert.equal(worker.isAllowedOrigin('https://evil.example', env), false);
  assert.equal(worker.isAllowedOrigin(null, env), false);
  assert.equal(worker.isAllowedOrigin(null, { ...env, ALLOW_NO_ORIGIN: 'true' }), true);
});

test('R2 lookup keys are deterministic', async () => {
  const worker = await loadWorker();
  assert.equal(worker.fixturePointerKey('af:fixture:123'), 'football/v2/indexes/fixture/af:fixture:123.json');
  assert.equal(worker.dateIndexKey('2026-08-22'), 'football/v2/indexes/date-jst/2026-08-22.json');
  assert.equal(
    worker.competitionDateIndexKey('af:competition:39', '2026-08-22'),
    'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
  );
});

test('competition date route reads the competition-scoped R2 index', async () => {
  const worker = await loadWorker();
  const requested = [];
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    FOOTBALL_DATA: {
      async get(key) {
        requested.push(key);
        return {
          body: JSON.stringify({ date: '2026-08-22', fixtures: [] }),
          httpMetadata: { contentType: 'application/json' },
          etag: 'test-etag',
        };
      },
    },
  };
  const request = new Request('https://worker.example/api/v2/competitions/af%3Acompetition%3A39/dates/2026-08-22', {
    headers: { origin: 'https://example.github.io' },
  });
  const response = await worker.default.fetch(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(requested, ['football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json']);
});
