const { test } = require('node:test');
const assert = require('node:assert/strict');

test('sums rows written across databases and selects the staging database', async () => {
  const { reportUsage } = await import('../scripts/d1/report-account-usage.mjs');
  let request;
  const result = await reportUsage({
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'secret',
    D1_DATABASE_ID: 'fdfd74e4-2702-4aa2-ab20-c062e952fe25',
  }, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ data: { viewer: { accounts: [{
      d1AnalyticsAdaptiveGroups: [
        { dimensions: { date: '2026-09-29', databaseId: 'fdfd74e4-2702-4aa2-ab20-c062e952fe25' }, sum: { rowsWritten: 25 } },
        { dimensions: { date: '2026-09-29', databaseId: 'other' }, sum: { rowsWritten: 35 } },
      ],
    }] } } }) };
  }, new Date('2026-09-29T11:00:00Z'));
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/graphql');
  assert.equal(request.options.method, 'POST');
  assert.equal(JSON.parse(request.options.body).variables.date, '2026-09-29');
  assert.equal(result.rowsWrittenAllDatabases, 60);
  assert.equal(result.rowsWrittenStagingDatabase, 25);
});

test('fails closed on a Cloudflare error, missing account or truncated groups', async () => {
  const { summarizeUsage } = await import('../scripts/d1/report-account-usage.mjs');
  const date = '2026-09-29';
  assert.throws(() => summarizeUsage({ errors: [{ message: 'denied' }] }, date), /GraphQL returned an error/);
  assert.throws(() => summarizeUsage({ data: { viewer: { accounts: [] } } }, date), /exactly one/);
  assert.throws(() => summarizeUsage({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: Array(10000).fill({}) }] } } }, date), /result limit/);
});
