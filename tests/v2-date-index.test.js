'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeDateIndex } = require('../scripts/v2/merge-date-index');

function fixture(id, kickoffUtc, statusShort = 'NS') {
  const providerId = Number(id.split(':').at(-1));
  return {
    fixtureId: id,
    competitionId: 'af:competition:39',
    seasonId: 'af:season:39:2026',
    kickoffUtc,
    dateJst: '2026-08-22',
    status: {
      short: statusShort,
      long: statusShort === 'FT' ? 'Match Finished' : 'Not Started',
      elapsed: statusShort === 'FT' ? 90 : null,
    },
    ingestionState: statusShort === 'FT' ? 'provisional_final' : 'scheduled',
    teams: {
      home: { id: `af:team:${providerId + 100}`, providerId: providerId + 100, name: 'Home', logo: null, winner: null },
      away: { id: `af:team:${providerId + 200}`, providerId: providerId + 200, name: 'Away', logo: null, winner: null },
    },
    score: {
      goals: { home: null, away: null },
      halftime: { home: null, away: null },
      fulltime: { home: null, away: null },
      extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
  };
}

function competition() {
  return {
    id: 'af:competition:39',
    providerId: 39,
    name: 'Premier League',
    country: 'England',
    logo: null,
    flag: null,
  };
}

test('date index merge upserts fixture IDs and keeps deterministic kickoff order', async () => {
  const current = {
    contractVersion: '2.0.0',
    timeZone: 'Asia/Tokyo',
    date: '2026-08-22',
    fixtures: [
      fixture('af:fixture:1', '2026-08-21T19:00:00.000Z'),
      fixture('af:fixture:2', '2026-08-21T21:00:00.000Z'),
    ],
    generatedAt: '2026-08-21T23:00:00.000Z',
  };
  const incoming = {
    contractVersion: '2.0.0',
    timeZone: 'Asia/Tokyo',
    date: '2026-08-22',
    fixtures: [
      fixture('af:fixture:2', '2026-08-21T21:00:00.000Z', 'FT'),
      fixture('af:fixture:3', '2026-08-21T21:00:00.000Z', 'FT'),
    ],
    generatedAt: '2026-08-22T01:00:00.000Z',
  };

  const merged = await mergeDateIndex(current, incoming, {
    expectedCompetitionId: null,
    mode: 'upsert',
  });
  assert.deepEqual(merged.fixtures.map(row => row.fixtureId), [
    'af:fixture:1', 'af:fixture:2', 'af:fixture:3',
  ]);
  assert.equal(merged.fixtures.find(row => row.fixtureId === 'af:fixture:2').status.short, 'FT');
});

test('authoritative competition replacement repairs legacy state and removes stale fixtures', async () => {
  const current = {
    contractVersion: '2.0.0',
    timeZone: 'Asia/Tokyo',
    date: '2026-08-22',
    fixtures: [fixture('af:fixture:1', '2026-08-21T19:00:00.000Z')],
    generatedAt: '2026-08-21T23:00:00.000Z',
  };
  const incoming = {
    contractVersion: '2.0.0',
    timeZone: 'Asia/Tokyo',
    date: '2026-08-22',
    competition: competition(),
    fixtures: [fixture('af:fixture:2', '2026-08-21T21:00:00.000Z')],
    generatedAt: '2026-08-22T01:00:00.000Z',
  };

  const merged = await mergeDateIndex(current, incoming, {
    expectedCompetitionId: 'af:competition:39',
    mode: 'replace',
  });

  assert.deepEqual(merged.competition, competition());
  assert.deepEqual(merged.fixtures.map(row => row.fixtureId), ['af:fixture:2']);
});

test('merge scope is mandatory and cannot be derived from the artifact under validation', async () => {
  const scoped = {
    contractVersion: '2.0.0',
    timeZone: 'Asia/Tokyo',
    date: '2026-08-22',
    competition: competition(),
    fixtures: [fixture('af:fixture:1', '2026-08-21T19:00:00.000Z')],
    generatedAt: '2026-08-21T23:00:00.000Z',
  };
  await assert.rejects(() => mergeDateIndex(null, scoped), /explicit expectedCompetitionId/);
  await assert.rejects(() => mergeDateIndex(null, { ...scoped, competition: undefined }, {
    expectedCompetitionId: 'af:competition:39', mode: 'replace',
  }), /competition must be an object/);
  await assert.rejects(() => mergeDateIndex(null, scoped, {
    expectedCompetitionId: 'af:competition:140', mode: 'replace',
  }), /must match af:competition:140/);
});

test('generic replace-scope removes stale fixtures only from the declared competition', async () => {
  const premierFixture = fixture('af:fixture:1', '2026-08-21T19:00:00.000Z');
  const laLigaFixture = {
    ...fixture('af:fixture:2', '2026-08-21T20:00:00.000Z'),
    competitionId: 'af:competition:140',
    seasonId: 'af:season:140:2026',
  };
  const current = {
    contractVersion: '2.0.0', timeZone: 'Asia/Tokyo', date: '2026-08-22',
    fixtures: [premierFixture, laLigaFixture],
    generatedAt: '2026-08-21T23:00:00.000Z',
  };
  const incoming = {
    contractVersion: '2.0.0', timeZone: 'Asia/Tokyo', date: '2026-08-22',
    fixtures: [],
    generatedAt: '2026-08-22T01:00:00.000Z',
  };

  const merged = await mergeDateIndex(current, incoming, {
    expectedCompetitionId: null,
    mode: 'replace-scope',
    replaceCompetitionId: 'af:competition:39',
  });

  assert.deepEqual(merged.fixtures.map(row => row.fixtureId), ['af:fixture:2']);
});
