'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('Paid D1 capacity gate sums every database and fails closed on missing or high usage', async () => {
  const { summarizePaidUsage } = await import('../scripts/d1/check-paid-backfill-capacity.mjs');
  const start = '2026-08-30';
  const end = '2026-09-29';
  const payload = rows => ({ data: { viewer: { accounts: [{
    d1AnalyticsAdaptiveGroups: rows.map((written, index) => ({
      dimensions: { date: end, databaseId: `db-${index}` },
      sum: { rowsWritten: written },
    })),
  }] } } });
  assert.equal(summarizePaidUsage(payload([20_000, 10_000]), start, end)
    .rowsWrittenTrailing31Days, 30_000);
  assert.throws(() => summarizePaidUsage(payload([40_000_001]), start, end),
    /conservative D1 monthly usage ceiling/);
  assert.throws(() => summarizePaidUsage(payload([-1]), start, end), /invalid/);
  assert.throws(() => summarizePaidUsage({ errors: [{ message: 'error' }] }, start, end), /errors/);
  assert.throws(() => summarizePaidUsage(payload([1, 2]).data.viewer.accounts[0], start, end),
    /missing or ambiguous/);
});
