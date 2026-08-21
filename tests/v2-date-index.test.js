'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeDateIndex } = require('../scripts/v2/merge-date-index');

test('date index merge upserts fixture IDs and keeps kickoff order', () => {
  const current = {
    contractVersion: '2.0.0',
    timeZone: 'Asia/Tokyo',
    date: '2026-08-22',
    fixtures: [
      { fixtureId: 'af:fixture:2', kickoffUtc: '2026-08-21T21:00:00.000Z', status: { short: 'NS' } },
      { fixtureId: 'af:fixture:1', kickoffUtc: '2026-08-21T19:00:00.000Z', status: { short: 'NS' } },
    ],
  };
  const incoming = {
    contractVersion: '2.0.0',
    timeZone: 'Asia/Tokyo',
    date: '2026-08-22',
    fixtures: [
      { fixtureId: 'af:fixture:2', kickoffUtc: '2026-08-21T21:00:00.000Z', status: { short: 'FT' } },
      { fixtureId: 'af:fixture:3', kickoffUtc: '2026-08-21T20:00:00.000Z', status: { short: 'FT' } },
    ],
    generatedAt: '2026-08-22T01:00:00Z',
  };

  const merged = mergeDateIndex(current, incoming);
  assert.deepEqual(merged.fixtures.map(row => row.fixtureId), [
    'af:fixture:1', 'af:fixture:3', 'af:fixture:2',
  ]);
  assert.equal(merged.fixtures.find(row => row.fixtureId === 'af:fixture:2').status.short, 'FT');
});
