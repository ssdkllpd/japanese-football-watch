'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { candidateScore, scanSnapshot } = require('../scripts/d1/report-player-identity-variance');

function fixture() {
  return {
    fixture: {
      id: 1563088,
      date: '2026-08-15T14:00:00+00:00',
      venue: { id: 1, name: 'Ground', city: 'City' },
      status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
    },
    league: { id: 40, name: 'Championship', country: 'England', season: 2026, round: 'Regular Season - 1' },
    teams: {
      home: { id: 71, name: 'Norwich', winner: false },
      away: { id: 60, name: 'West Brom', winner: true },
    },
    goals: { home: 1, away: 2 },
    score: {
      halftime: { home: 0, away: 0 }, fulltime: { home: 1, away: 2 },
      extratime: { home: null, away: null }, penalty: { home: null, away: null },
    },
    events: [], statistics: [],
    lineups: [{
      team: { id: 60, name: 'West Brom' }, formation: '4-2-3-1', coach: null,
      startXI: [{ player: { id: 544659, name: 'J. Morgan', number: 11, pos: 'F', grid: '4:1' } }],
      substitutes: [],
    }],
    players: [{
      team: { id: 60, name: 'West Brom' },
      players: [{
        player: { id: 330982, name: 'Jimmy Morgan', photo: null },
        statistics: [{ games: { minutes: 89, position: 'F', substitute: false, captain: false } }],
      }],
    }],
  };
}

test('name candidate scoring accepts a matching surname and first initial only', () => {
  assert.equal(candidateScore({ name: 'J. Morgan' }, { name: 'Jimmy Morgan' }), 90);
  assert.equal(candidateScore({ name: 'J. Morgan' }, { name: 'Alex Morgan' }), 0);
  assert.equal(candidateScore({ name: 'Jimmy Morgan' }, { name: 'Jimmy Morgan' }), 100);
});

test('snapshot scan reports reviewed and unreviewed identity variance without changing the data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-identity-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const completed = path.join(root, 'league-40', 'completed-fixtures');
  fs.mkdirSync(completed, { recursive: true });
  fs.writeFileSync(path.join(completed, '1563088.json'), JSON.stringify(fixture()));
  const players = path.join(root, 'league-40', 'players');
  fs.mkdirSync(players, { recursive: true });
  fs.writeFileSync(path.join(players, 'page-1.json'), JSON.stringify({ response: [{
    player: { id: 330982, name: 'Jimmy Morgan' },
    statistics: [{ team: { id: 60 } }],
  }] }));
  const squads = path.join(root, 'league-40', 'squads');
  fs.mkdirSync(squads, { recursive: true });
  fs.writeFileSync(path.join(squads, '60.json'), JSON.stringify({ response: [{
    team: { id: 60 }, players: [{ id: 330982, name: 'Jimmy Morgan' }],
  }] }));
  const latest = {
    provider: 'api-football', snapshotId: '20260908-021509068Z',
    archiveKey: 'audit/example.tar.gz', archiveSha256: 'a'.repeat(64),
    completedAt: '2026-09-08T02:15:09.068Z',
  };
  const evidence = {
    snapshotId: latest.snapshotId,
    playerAliases: [{
      observedAt: latest.completedAt, league: 40, season: 2026, teamId: 'af:team:60',
      aliasPlayerId: 'af:player:544659', canonicalPlayerId: 'af:player:330982',
    }],
  };
  const latestPath = path.join(root, 'latest.json');
  const evidencePath = path.join(root, 'evidence.json');
  fs.writeFileSync(latestPath, JSON.stringify(latest));
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));

  const report = scanSnapshot({ snapshotRoot: root, latest: latestPath, evidence: evidencePath });
  assert.equal(report.summary.fixturesScanned, 1);
  assert.equal(report.summary.candidateCount, 1);
  assert.equal(report.summary.unreviewedCandidateCount, 0);
  assert.equal(report.candidates[0].aliasPlayerId, 'af:player:544659');
  assert.equal(report.candidates[0].canonicalPlayerId, 'af:player:330982');
  assert.equal(report.candidates[0].alreadyReviewed, true);
  assert.deepEqual(report.candidates[0].evidence.lineupIdentity.seasonNames, []);
  assert.deepEqual(report.candidates[0].evidence.playerStatsIdentity.seasonNames, ['Jimmy Morgan']);
  assert.equal(report.candidates[0].evidence.playerStatsIdentity.seasonListsFixtureTeam, true);
  assert.equal(report.candidates[0].evidence.playerStatsIdentity.squadListsFixtureTeam, true);
  assert.equal(report.findings[0].counts.appearanceUnion, 2);
  assert.equal(report.findings[0].counts.projectedAfterCandidates, 1);
});
