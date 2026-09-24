'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ApiFootballClient,
  ApiFootballError,
  createClientFromEnv,
  extractQuota,
  hasApiErrors,
} = require('../scripts/api-football/client');
const { discoverAutomation, } = require('../scripts/v2/discover-api-football-automation');
const policy = require('../config/api-football-automation.json');

function headers(values = {}) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    get(name) {
      return normalized[String(name).toLowerCase()] ?? null;
    },
  };
}

test('client refuses to start without API key', () => {
  assert.throws(
    () => new ApiFootballClient({ apiKey: '' }),
    (error) => error instanceof ApiFootballError && /API_FOOTBALL_KEY/.test(error.message)
  );
});

test('client sends key only in x-apisports-key header and returns quota metadata', async () => {
  let capturedUrl;
  let capturedOptions;
  const fakeFetch = async (url, options) => {
    capturedUrl = String(url);
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      headers: headers({
        'x-ratelimit-requests-limit': '100',
        'x-ratelimit-requests-remaining': '99',
        'x-ratelimit-limit': '10',
        'x-ratelimit-remaining': '9',
      }),
      async json() {
        return {
          get: 'fixtures',
          parameters: { league: '39', season: '2026' },
          errors: [],
          results: 1,
          paging: { current: 1, total: 1 },
          response: [{ fixture: { id: 123 } }],
        };
      },
    };
  };

  const client = new ApiFootballClient({ apiKey: 'secret-value', fetchImpl: fakeFetch });
  const result = await client.get('/fixtures', { league: 39, season: 2026 });

  assert.match(capturedUrl, /fixtures\?league=39&season=2026/);
  assert.equal(capturedOptions.method, 'GET');
  assert.equal(capturedOptions.headers['x-apisports-key'], 'secret-value');
  assert.equal(capturedUrl.includes('secret-value'), false);
  assert.deepEqual(result.quota, {
    dailyLimit: 100,
    dailyRemaining: 99,
    minuteLimit: 10,
    minuteRemaining: 9,
  });
});

test('API-level errors are rejected even on HTTP 200', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    headers: headers(),
    async json() {
      return { errors: { token: 'Invalid API key' }, response: [] };
    },
  });

  const client = new ApiFootballClient({ apiKey: 'bad-key', fetchImpl: fakeFetch });
  await assert.rejects(
    () => client.get('/countries'),
    (error) => error instanceof ApiFootballError && /API-level error/.test(error.message)
  );
});

test('quota parsing keeps unknown values as null', () => {
  assert.deepEqual(extractQuota(headers({ 'x-ratelimit-requests-remaining': '42' })), {
    dailyLimit: null,
    dailyRemaining: 42,
    minuteLimit: null,
    minuteRemaining: null,
  });
});

test('API error detector handles both array and object response shapes', () => {
  assert.equal(hasApiErrors([]), false);
  assert.equal(hasApiErrors({}), false);
  assert.equal(hasApiErrors(['bad']), true);
  assert.equal(hasApiErrors({ request: 'bad' }), true);
});

test('client serializes concurrent calls and enforces minimum request spacing', async () => {
  let clock = 1000;
  let inFlight = 0;
  let maximumInFlight = 0;
  const starts = [];
  const client = new ApiFootballClient({
    apiKey: 'secret',
    minimumIntervalMs: 300,
    nowImpl: () => clock,
    sleepImpl: async delay => { clock += delay; },
    fetchImpl: async () => {
      starts.push(clock);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return {
        ok: true, status: 200, headers: headers(),
        async json() { return { errors: [], response: [] }; },
      };
    },
  });

  await Promise.all([client.get('fixtures'), client.get('fixtures/events'), client.get('fixtures/players')]);
  assert.equal(maximumInFlight, 1);
  assert.deepEqual(starts, [1000, 1300, 1600]);
});

test('client stops before consuming the protected daily reserve', async () => {
  let calls = 0;
  const client = new ApiFootballClient({
    apiKey: 'secret',
    dailyReserve: 100,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true, status: 200,
        headers: headers({ 'x-ratelimit-requests-remaining': '100' }),
        async json() { return { errors: [], response: [] }; },
      };
    },
  });
  await client.get('fixtures');
  await assert.rejects(() => client.get('fixtures/events'), /daily reserve reached/);
  assert.equal(calls, 1);
});

test('free status quota check blocks discovery before the first charged request at reserve', async () => {
  let charged = 0;
  let statusCalls = 0;
  const client = new ApiFootballClient({
    apiKey: 'secret', dailyReserve: 100,
    fetchImpl: async url => {
      if (new URL(url).pathname === '/status') {
        statusCalls += 1;
        return { ok: true, status: 200, headers: headers(),
          async json() { return { errors: [], response: { requests: { current: 6900, limit_day: 7000 } } }; } };
      }
      charged += 1;
      throw new Error('Unexpected charged API request');
    },
  });
  await assert.rejects(() => discoverAutomation({
    policy, state: null, client, preview: true, now: '2026-09-17T12:00:00Z',
  }), /daily reserve reached/);
  assert.equal(statusCalls, 1);
  assert.equal(charged, 0);
});

test('client fails closed when a protected response omits its quota header', async () => {
  const client = new ApiFootballClient({
    apiKey: 'secret', dailyReserve: 100,
    fetchImpl: async () => ({
      ok: true, status: 200, headers: headers(),
      async json() { return { errors: [], response: [] }; },
    }),
  });
  await assert.rejects(() => client.get('fixtures'), /omitted the daily remaining quota/);
});

test('environment factory validates automation throttling values', () => {
  const client = createClientFromEnv({
    API_FOOTBALL_KEY: 'secret',
    API_FOOTBALL_MIN_INTERVAL_MS: '300',
    API_FOOTBALL_DAILY_RESERVE: '100',
    API_FOOTBALL_INITIAL_DAILY_REMAINING: '250',
  }, { fetchImpl: async () => {} });
  assert.equal(client.minimumIntervalMs, 300);
  assert.equal(client.dailyReserve, 100);
  assert.equal(client.lastQuota.dailyRemaining, 250);
  assert.throws(() => createClientFromEnv({
    API_FOOTBALL_KEY: 'secret', API_FOOTBALL_MIN_INTERVAL_MS: 'invalid',
  }), /minimumIntervalMs/);
});
