'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildDateFeed,
  competitionDateIndexKey,
  writeDateFeed,
} = require('../scripts/v2/fetch-date-feed');

function fixture({ id, leagueId, leagueName, kickoff, status = 'NS', homeScore = null, awayScore = null }) {
  return {
    fixture: {
      id,
      date: kickoff,
      status: { short: status, long: status === 'FT' ? 'Match Finished' : 'Not Started', elapsed: status === 'FT' ? 90 : null },
      venue: { id: id + 1000, name: `Venue ${id}`, city: 'Test City' },
    },
    league: {
      id: leagueId,
      name: leagueName,
      country: 'Testland',
      season: 2026,
      logo: `https://media.api-sports.io/football/leagues/${leagueId}.png`,
      flag: null,
      round: 'Regular Season - 1',
    },
    teams: {
      home: { id: id + 10, name: `Home ${id}`, logo: null, winner: null },
      away: { id: id + 20, name: `Away ${id}`, logo: null, winner: null },
    },
    goals: { home: homeScore, away: awayScore },
    score: {
      halftime: { home: null, away: null },
      fulltime: { home: homeScore, away: awayScore },
      extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
  };
}

test('generic date feed groups fixtures by competition and keeps competition presentation data', () => {
  const feed = buildDateFeed([
    fixture({ id: 101, leagueId: 39, leagueName: 'Premier League', kickoff: '2026-08-21T20:00:00Z' }),
    fixture({ id: 102, leagueId: 78, leagueName: 'Bundesliga', kickoff: '2026-08-21T21:00:00Z', status: 'FT', homeScore: 0, awayScore: 2 }),
  ], {
    date: '2026-08-22',
    fetchedAt: '2026-08-21T22:00:00Z',
  });

  assert.equal(feed.dateIndex.fixtures.length, 2);
  assert.deepEqual(feed.dateIndex.fixtures.map(row => row.competition.name), ['Premier League', 'Bundesliga']);
  assert.equal(feed.competitionIndexes.length, 2);
  assert.equal(feed.dateIndex.fixtures[1].score.goals.home, 0);
  assert.equal(feed.dateIndex.fixtures[1].score.goals.away, 2);
  assert.equal(feed.dateIndex.fixtures[1].ingestionState, 'provisional_final');
  assert.equal(feed.bundles[0].sectionStates.events.presence, 'not_fetched');
  assert.equal(feed.bundles[0].sectionStates.playerStats.presence, 'not_fetched');
});

test('date feed ignores provider rows that do not belong to the requested JST date', () => {
  const feed = buildDateFeed([
    fixture({ id: 201, leagueId: 39, leagueName: 'Premier League', kickoff: '2026-08-21T13:00:00Z' }),
    fixture({ id: 202, leagueId: 39, leagueName: 'Premier League', kickoff: '2026-08-21T16:00:00Z' }),
  ], {
    date: '2026-08-22',
    fetchedAt: '2026-08-21T22:00:00Z',
  });

  assert.deepEqual(feed.dateIndex.fixtures.map(row => row.fixtureId), ['af:fixture:202']);
  assert.equal(feed.competitionIndexes[0].fixtures.length, 1);
});

test('date feed uses fixture ID as the deterministic tie-breaker for equal kickoffs', () => {
  const feed = buildDateFeed([
    fixture({ id: 302, leagueId: 39, leagueName: 'Premier League', kickoff: '2026-08-21T20:00:00Z' }),
    fixture({ id: 301, leagueId: 39, leagueName: 'Premier League', kickoff: '2026-08-21T20:00:00Z' }),
  ], {
    date: '2026-08-22',
    fetchedAt: '2026-08-21T22:00:00Z',
  });

  assert.deepEqual(feed.dateIndex.fixtures.map(row => row.fixtureId), [
    'af:fixture:301', 'af:fixture:302',
  ]);
  assert.deepEqual(feed.competitionIndexes[0].fixtures.map(row => row.fixtureId), [
    'af:fixture:301', 'af:fixture:302',
  ]);
});

test('competition date index key is explicit about competition and JST date', () => {
  assert.equal(
    competitionDateIndexKey('af:competition:39', '2026-08-22'),
    'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
  );
});

test('publisher manifest declares authoritative replacement scope for every date index', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-date-feed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const feed = buildDateFeed([
    fixture({ id: 401, leagueId: 39, leagueName: 'Premier League', kickoff: '2026-08-21T20:00:00Z' }),
  ], { date: '2026-08-22', fetchedAt: '2026-08-21T22:00:00Z' });

  const scoped = writeDateFeed(path.join(directory, 'scoped'), feed, {
    query: { date: '2026-08-22', league: '39' },
  });
  const scopedIndexes = scoped.r2Objects.filter(item => item.merge === 'date_index');
  assert.deepEqual(scopedIndexes.map(item => ({
    scope: item.mergeScope,
    mode: item.mergeMode,
    replace: item.mergeReplaceCompetitionId ?? null,
  })), [
    { scope: 'generic', mode: 'replace-scope', replace: 'af:competition:39' },
    { scope: 'af:competition:39', mode: 'replace', replace: null },
  ]);

  const complete = writeDateFeed(path.join(directory, 'complete'), feed, {
    query: { date: '2026-08-22' },
  });
  assert.equal(complete.r2Objects[0].mergeMode, 'replace');
  assert.equal(complete.r2Objects[0].mergeReplaceCompetitionId, null);
});
