'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeStandings,
  standingsLatestKey,
  standingsSnapshotKey,
  validateStandings,
  writeStandings,
} = require('../scripts/v2/fetch-standings');

function providerResponse() {
  return [{
    league: {
      id: 39,
      name: 'Premier League',
      country: 'England',
      logo: 'https://media.example/league.png',
      flag: 'https://media.example/flag.svg',
      season: 2026,
      standings: [[
        {
          rank: 1,
          team: { id: 40, name: 'Liverpool', logo: 'https://media.example/40.png' },
          points: 3,
          goalsDiff: 2,
          group: 'Premier League',
          form: 'W',
          status: 'same',
          description: 'Champions League',
          all: { played: 1, win: 1, draw: 0, lose: 0, goals: { for: 2, against: 0 } },
          home: { played: 1, win: 1, draw: 0, lose: 0, goals: { for: 2, against: 0 } },
          away: { played: 0, win: 0, draw: 0, lose: 0, goals: { for: 0, against: 0 } },
          update: '2026-08-22T01:00:00Z',
        },
        {
          rank: 2,
          team: { id: 50, name: 'Arsenal', logo: null },
          points: null,
          goalsDiff: null,
          group: 'Premier League',
          all: {},
        },
      ]],
    },
  }];
}

test('standings normalization keeps provider-native identity and explicit zero values', () => {
  const snapshot = normalizeStandings(providerResponse(), {
    league: 39,
    season: 2026,
    fetchedAt: '2026-08-22T02:00:00Z',
  });

  assert.equal(snapshot.competition.id, 'af:competition:39');
  assert.equal(snapshot.season.id, 'af:season:39:2026');
  assert.equal(snapshot.groups[0].table[0].team.id, 'af:team:40');
  assert.equal(snapshot.groups[0].table[0].overall.draws, 0);
  assert.equal(snapshot.groups[0].table[0].away.played, 0);
  assert.equal(snapshot.groups[0].table[1].points, null);
  assert.equal(snapshot.groups[0].table[1].overall.played, null);
  assert.equal(snapshot.sectionStates.standings.presence, 'present');
  assert.deepEqual(validateStandings(snapshot), []);
});

test('standings R2 keys include competition-specific season identity', () => {
  assert.equal(
    standingsLatestKey('af:competition:39', 'af:season:39:2026'),
    'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/standings/latest.json',
  );
  assert.equal(
    standingsSnapshotKey('af:competition:39', 'af:season:39:2026', '2026-08-22T02:03:04Z'),
    'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/standings/snapshots/20260822T020304Z.json',
  );
});

test('standings writer publishes an immutable snapshot and a latest object', () => {
  const snapshot = normalizeStandings(providerResponse(), {
    league: 39,
    season: 2026,
    fetchedAt: '2026-08-22T02:00:00Z',
  });
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-standings-'));
  const manifest = writeStandings(outputDir, snapshot, {
    query: { league: 39, season: 2026 },
    quota: { dailyRemaining: 7000 },
  });

  assert.equal(manifest.rowCount, 2);
  assert.deepEqual(manifest.r2Objects.map(item => item.role), ['standings_snapshot', 'standings_latest']);
  assert.ok(fs.existsSync(path.join(outputDir, 'standings.json')));
  assert.ok(fs.existsSync(path.join(outputDir, 'manifest.json')));
});
