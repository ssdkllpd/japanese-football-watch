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
      provider: 'api-football', snapshotId: latest.snapshotId,
      observedAt: latest.completedAt, league: 40, season: 2026, teamId: 'af:team:60',
      aliasPlayerId: 'af:player:544659', aliasProviderId: 544659,
      canonicalPlayerId: 'af:player:330982', canonicalProviderId: 330982,
      reason: 'test reviewed variance',
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
  assert.equal(report.summary.maxLineupEntries, 1);
  assert.equal(report.summary.maxPlayerStats, 1);
  assert.equal(report.candidates[0].aliasPlayerId, 'af:player:544659');
  assert.equal(report.candidates[0].canonicalPlayerId, 'af:player:330982');
  assert.equal(report.candidates[0].alreadyReviewed, true);
  assert.deepEqual(report.candidates[0].evidence.lineupIdentity.seasonNames, []);
  assert.deepEqual(report.candidates[0].evidence.playerStatsIdentity.seasonNames, ['Jimmy Morgan']);
  assert.equal(report.candidates[0].evidence.playerStatsIdentity.seasonListsFixtureTeam, true);
  assert.equal(report.candidates[0].evidence.playerStatsIdentity.squadListsFixtureTeam, true);
  assert.equal(report.findings[0].counts.appearanceUnion, 2);
  assert.equal(report.findings[0].counts.projectedAfterCandidates, 1);
  assert.equal(report.findings[0].counts.reviewedAppearanceUnion, 1);
});

test('includes saved catalog evidence for unresolved endpoint identities', () => {
  const raw = fixture();
  raw.lineups[0].startXI[0].player.name = 'Unmatched Lineup Name';
  const inspected = require('../scripts/d1/report-player-identity-variance').inspectFixture(
    raw, '2026-09-08T02:15:09.068Z', new Map(), {
      season: new Map([[330982, { names: new Set(['Jimmy Morgan']), teamIds: new Set(['af:team:60']) }]]),
      squad: new Map(),
    },
  );
  assert.deepEqual(
    inspected.teams[1].unresolvedStatsOnly[0].identityEvidence.seasonNames,
    ['Jimmy Morgan'],
  );
  assert.equal(inspected.teams[1].unresolvedStatsOnly[0].identityEvidence.seasonListsFixtureTeam, true);
});

test('counts missing provider identities by endpoint row and never treats null event ids as evidence', () => {
  const raw = fixture();
  raw.lineups[0].substitutes = [{
    player: { id: null, name: 'Unidentified Player', number: 20, pos: 'M', grid: null },
  }];
  raw.players[0].players.push({
    player: { id: 0, name: 'Unidentified Player', photo: null },
    statistics: [{ games: { minutes: 0, position: null, substitute: false, captain: false } }],
  });
  raw.events.push({
    time: { elapsed: 90, extra: null }, team: { id: 60 },
    player: { id: null, name: 'Someone Else' }, assist: null,
    type: 'Card', detail: 'Yellow Card', comments: null,
  });

  const inspected = require('../scripts/d1/report-player-identity-variance').inspectFixture(
    raw, '2026-09-08T02:15:09.068Z', new Map(),
  );
  const candidate = inspected.teams[1].candidates.find(item => item.aliasName === 'Unidentified Player');
  assert.equal(candidate.aliasPlayerId, null);
  assert.equal(candidate.canonicalPlayerId, null);
  assert.equal(candidate.evidence.lineupEventReferences, 0);
  assert.equal(candidate.evidence.playerStatsEventReferences, 0);
  assert.equal(inspected.counts.providerMissingPlayerIdentityOmissions, 2);
});

test('reports every positive player id repeated within lineup and player-stat endpoints', () => {
  const raw = fixture();
  raw.lineups[0].substitutes.push({
    player: { id: 544659, name: 'Different Person', number: 20, pos: 'M', grid: null },
  });
  raw.players[0].players.push({
    player: { id: 330982, name: 'Another Person', photo: null },
    statistics: [{ games: { minutes: 0, position: 'M', substitute: true, captain: false } }],
  });

  const inspected = require('../scripts/d1/report-player-identity-variance').inspectFixture(
    raw, '2026-09-08T02:15:09.068Z', new Map(), undefined, [],
  );
  assert.deepEqual(inspected.duplicateLineupPlayers.map(item => item.playerId), ['af:player:544659']);
  assert.equal(inspected.duplicateLineupPlayers[0].occurrences.length, 2);
  assert.deepEqual(inspected.duplicatePlayerStats.map(item => item.playerId), ['af:player:330982']);
  assert.equal(inspected.duplicatePlayerStats[0].occurrences.length, 2);
  assert.equal(inspected.counts.duplicateLineupEntryCount, 2);
  assert.equal(inspected.counts.duplicatePlayerStatsRowCount, 2);
});

test('reports every lineup coach whose provider identity is zero or missing', () => {
  const raw = fixture();
  raw.lineups[0].coach = { id: 0, name: 'Coach Without ID', photo: null };

  const inspected = require('../scripts/d1/report-player-identity-variance').inspectFixture(
    raw, '2026-09-08T02:15:09.068Z', new Map(),
  );
  assert.deepEqual(inspected.providerMissingCoaches, [{
    fixtureId: 'af:fixture:1563088',
    teamId: 'af:team:60',
    lineupIndex: 0,
    coachId: null,
    providerId: 0,
    name: 'Coach Without ID',
    photo: null,
  }]);
  assert.equal(inspected.counts.providerMissingCoachIdentityCount, 1);
});

test('recognizes a reviewed alias regardless of which endpoint identity is canonical', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-identity-report-reversed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const completed = path.join(root, 'league-40', 'completed-fixtures');
  fs.mkdirSync(completed, { recursive: true });
  fs.writeFileSync(path.join(completed, '1563088.json'), JSON.stringify(fixture()));
  const latest = {
    provider: 'api-football', snapshotId: '20260908-021509068Z',
    archiveKey: 'audit/example.tar.gz', archiveSha256: 'a'.repeat(64),
    completedAt: '2026-09-08T02:15:09.068Z',
  };
  const evidence = {
    snapshotId: latest.snapshotId,
    playerAliases: [{
      provider: 'api-football', snapshotId: latest.snapshotId,
      observedAt: latest.completedAt, league: 40, season: 2026, teamId: 'af:team:60',
      aliasPlayerId: 'af:player:330982', aliasProviderId: 330982,
      canonicalPlayerId: 'af:player:544659', canonicalProviderId: 544659,
      reason: 'test reversed reviewed variance',
    }],
  };
  const latestPath = path.join(root, 'latest.json');
  const evidencePath = path.join(root, 'evidence.json');
  fs.writeFileSync(latestPath, JSON.stringify(latest));
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));

  const report = scanSnapshot({ snapshotRoot: root, latest: latestPath, evidence: evidencePath });
  assert.equal(report.candidates[0].alreadyReviewed, true);
  assert.equal(report.summary.unreviewedCandidateCount, 0);
});
