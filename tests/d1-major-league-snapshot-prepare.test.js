'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { prepare } = require('../scripts/d1/prepare-major-league-d1-migration');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function envelope(parameters, response) {
  return { get: 'test', parameters, errors: [], results: response.length, paging: { current: 1, total: 1 }, response };
}

function standing(team, rank) {
  const scope = { played: 1, win: rank === 1 ? 1 : 0, draw: 0, lose: rank === 1 ? 0 : 1, goals: { for: rank === 1 ? 2 : 0, against: rank === 1 ? 0 : 2 } };
  return {
    rank,
    team,
    points: rank === 1 ? 3 : 0,
    goalsDiff: rank === 1 ? 2 : -2,
    group: 'League',
    form: null,
    status: 'same',
    description: null,
    all: scope,
    home: scope,
    away: { played: 0, win: 0, draw: 0, lose: 0, goals: { for: 0, against: 0 } },
    update: '2026-09-01T00:00:00+00:00',
  };
}

function buildSnapshot({ seasonEnd = '2027-05-31', fixtureLeague = 39 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-d1-prepare-'));
  const snapshotRoot = path.join(root, 'snapshot');
  const leagueDir = path.join(snapshotRoot, 'league-39');
  const outputRoot = path.join(root, 'output');
  const archiveFile = path.join(root, 'snapshot.tar.gz');
  fs.mkdirSync(leagueDir, { recursive: true });
  fs.writeFileSync(archiveFile, 'immutable-test-archive');
  const archiveSha256 = createHash('sha256').update(fs.readFileSync(archiveFile)).digest('hex');
  const archiveKey = 'audit/api-football/v3/major-leagues/2026/snapshots/20260908-021509068Z.tar.gz';
  const observedAt = '2026-09-08T02:15:09.068Z';
  const team1 = { id: 1, name: 'Alpha', code: 'ALP', logo: 'https://example.com/1.png' };
  const team2 = { id: 2, name: 'Beta', code: 'BET', logo: 'https://example.com/2.png' };
  const fixture = {
    fixture: {
      id: 100,
      date: '2026-09-01T18:00:00+00:00',
      timestamp: 1788285600,
      referee: null,
      venue: { id: 10, name: 'Example Stadium', city: 'London' },
      status: { long: 'Match Finished', short: 'FT', elapsed: 90 },
    },
    league: { id: fixtureLeague, name: 'Premier League', country: 'England', logo: null, flag: null, season: 2026, round: 'Regular Season - 1' },
    teams: { home: { ...team1, winner: true }, away: { ...team2, winner: false } },
    goals: { home: 2, away: 0 },
    score: {
      halftime: { home: 1, away: 0 },
      fulltime: { home: 2, away: 0 },
      extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
  };
  const completed = { ...fixture, events: [], lineups: [], players: [], statistics: [] };
  writeJson(path.join(leagueDir, 'league.json'), envelope({ id: '39', season: '2026' }, [{
    league: { id: 39, name: 'Premier League', type: 'League', logo: null },
    country: { name: 'England', code: 'GB', flag: null },
    seasons: [{ year: 2026, start: '2026-08-01', end: seasonEnd, current: true, coverage: {} }],
  }]));
  writeJson(path.join(leagueDir, 'teams.json'), envelope({ league: '39', season: '2026' }, [
    { team: team1, venue: { id: 10, name: 'Example Stadium', city: 'London' } },
    { team: team2, venue: { id: 20, name: 'Beta Ground', city: 'London' } },
  ]));
  writeJson(path.join(leagueDir, 'fixtures.json'), envelope({ league: '39', season: '2026', timezone: 'Asia/Tokyo' }, [fixture]));
  writeJson(path.join(leagueDir, 'standings.json'), envelope({ league: '39', season: '2026' }, [{
    league: {
      id: 39, name: 'Premier League', country: 'England', logo: null, flag: null, season: 2026,
      standings: [[standing(team1, 1), standing(team2, 2)]],
    },
  }]));
  writeJson(path.join(leagueDir, 'players', 'page-1.json'), envelope({ league: '39', season: '2026', page: '1' }, [
    { player: { id: 101, name: 'Player One' }, statistics: [] },
  ]));
  for (const team of [team1, team2]) {
    writeJson(path.join(leagueDir, 'squads', `${team.id}.json`), envelope({ team: String(team.id) }, [{ team, players: [{ id: team.id * 100, name: 'Squad Player' }] }]));
    writeJson(path.join(leagueDir, 'coaches', `${team.id}.json`), envelope({ team: String(team.id) }, [{ id: team.id * 10, name: 'Coach' }]));
    writeJson(path.join(leagueDir, 'team-statistics', `${team.id}.json`), envelope({ league: '39', season: '2026', team: String(team.id) }, [{}]));
  }
  writeJson(path.join(leagueDir, 'completed-fixtures', '100.json'), completed);

  const totals = {
    teams: 2,
    fixtures: 1,
    completedFixtures: 1,
    completedFixtureDetails: 1,
    standingsRows: 2,
    playerRows: 1,
    uniquePlayersByLeague: 1,
    squadPlayers: 2,
    coaches: 2,
  };
  const manifest = {
    schemaVersion: 'jfw-api-football-major-leagues-snapshot/1',
    provider: 'api-football',
    apiVersion: 'v3',
    startedAt: '2026-09-08T02:00:00.000Z',
    completedAt: observedAt,
    snapshotId: '20260908-021509068Z',
    complete: true,
    targetCount: 1,
    leagues: [{
      competitionId: 'af:competition:39', seasonId: 'af:season:39:2026', league: 39, season: 2026,
      name: 'Premier League', teams: 2, fixtures: 1, completedFixtures: 1,
      completedFixtureDetails: 1, detailFallbackRequests: 0, standingsRows: 2,
      playerPages: 1, playerRows: 1, uniquePlayers: 1, squadPlayers: 2, coaches: 2,
    }],
    totals,
    quota: { requestsUsed: 1, dailyLimit: 7500, dailyRemaining: 7499, minuteLimit: 300, minuteRemaining: 299, reserve: 50 },
    r2: {
      archiveKey,
      manifestKey: 'audit/api-football/v3/major-leagues/2026/snapshots/20260908-021509068Z.manifest.json',
      latestKey: 'audit/api-football/v3/major-leagues/2026/latest.json',
    },
  };
  writeJson(path.join(snapshotRoot, 'manifest.json'), manifest);
  const latest = { ...manifest, archiveSha256, archiveKey };
  const latestPath = path.join(root, 'latest.json');
  const configPath = path.join(root, 'config.json');
  writeJson(latestPath, latest);
  writeJson(configPath, {
    schemaVersion: 'jfw-d1-admin-ingest-plan/1', fixtures: [],
    standings: [{ competitionId: 'af:competition:39', seasonId: 'af:season:39:2026' }],
    dateIndexCoverages: [], expectedTotals: null,
  });
  return { root, snapshotRoot, outputRoot, archiveFile, latestPath, configPath };
}

function run(paths) {
  return prepare({
    snapshotRoot: paths.snapshotRoot,
    outputRoot: paths.outputRoot,
    archiveFile: paths.archiveFile,
    latest: paths.latestPath,
    config: paths.configPath,
  });
}

test('prepares hash-scoped D1 artifacts only after the season boundary gate passes', () => {
  const paths = buildSnapshot();
  const result = run(paths);
  assert.equal(result.validationReport.passed, true);
  assert.deepEqual(result.validationReport.seasonGate[0], {
    league: 39,
    competitionId: 'af:competition:39',
    seasonId: 'af:season:39:2026',
    providerSeason: 2026,
    startsOn: '2026-08-01',
    endsOn: '2027-05-31',
    fixtureBoundaryAdjustmentCount: 0,
    passed: true,
  });
  assert.equal(result.migrationManifest.publicR2ObjectsWritten, false);
  assert.equal(result.migrationManifest.d1WritesPerformed, false);
  assert.equal(result.migrationManifest.leagues[0].fixtureArtifacts.length, 1);
  assert.match(result.migrationManifest.leagues[0].coreArtifact.r2Key,
    /^migration\/api-football\/v3\/major-leagues\/2026\/[0-9a-f]{64}\//);
  assert.ok(fs.existsSync(path.join(paths.outputRoot, 'core', 'league-39.json')));
  assert.ok(fs.existsSync(path.join(paths.outputRoot, 'fixtures', '39', '100.json')));
});

test('fails closed when provider season 2026 does not end in 2027', () => {
  const paths = buildSnapshot({ seasonEnd: '2026-12-31' });
  assert.throws(() => run(paths), /does not end in 2027/);
  assert.equal(fs.existsSync(path.join(paths.outputRoot, 'migration-manifest.json')), false);
});

test('fails closed when a fixture belongs to another competition', () => {
  const paths = buildSnapshot({ fixtureLeague: 40 });
  assert.throws(() => run(paths), /outside the declared competition-season/);
});
