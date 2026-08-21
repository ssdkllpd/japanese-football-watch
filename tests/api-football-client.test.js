'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ApiFootballClient,
  ApiFootballError,
  extractQuota,
  hasApiErrors,
} = require('../scripts/api-football/client');

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
