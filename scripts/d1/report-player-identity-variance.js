'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeFixtureBundle } = require('../v2/fixture-contract');

const REPORT_SCHEMA = 'jfw-player-identity-variance-report/1';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[item.slice(2)] = true;
    else {
      result[item.slice(2)] = next;
      index += 1;
    }
  }
  return result;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${filePath} is not readable JSON: ${error.message}`);
  }
}

function normalizedName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function nameIdentity(value) {
  const parts = normalizedName(value).split(/\s+/).filter(Boolean);
  return {
    normalized: parts.join(' '),
    firstInitial: parts[0]?.[0] || null,
    surname: parts.at(-1) || null,
  };
}

function candidateScore(lineup, stat) {
  const left = nameIdentity(lineup.name);
  const right = nameIdentity(stat.name);
  if (!left.normalized || !right.normalized) return 0;
  if (left.normalized === right.normalized) return 100;
  if (left.surname === right.surname && left.firstInitial === right.firstInitial) return 90;
  return 0;
}

function uniqueBest(items, score) {
  const ranked = items.map(item => ({ item, score: score(item) })).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) return null;
  return ranked[0];
}

function reviewedAliasMap(evidence) {
  const result = new Map();
  for (const rule of evidence.playerAliases || []) {
    const key = [rule.league, rule.season, rule.teamId, rule.aliasPlayerId, rule.canonicalPlayerId].join('|');
    result.set(key, rule);
  }
  return result;
}

function teamName(bundle, teamId) {
  for (const side of ['home', 'away']) {
    if (bundle.fixture.teams[side].id === teamId) return bundle.fixture.teams[side].name;
  }
  return null;
}

function lineupPlayers(bundle, teamId) {
  const lineup = bundle.lineups.find(item => item.teamId === teamId);
  if (!lineup) return [];
  return [...lineup.startXI, ...lineup.substitutes].map(player => ({
    id: player.id,
    providerId: player.providerId,
    name: player.name,
    role: player.role,
    number: player.number,
    position: player.position,
  }));
}

function statPlayers(bundle, teamId) {
  return bundle.playerStats.filter(item => item.teamId === teamId).map(item => ({
    id: item.playerId,
    providerId: item.playerProviderId,
    name: item.playerName,
    role: item.starter === true ? 'starter' : 'substitute',
    minutes: item.values?.minutes ?? null,
    position: item.position,
  }));
}

function inspectTeam(bundle, teamId, scope, aliases) {
  const lineup = lineupPlayers(bundle, teamId);
  const stats = statPlayers(bundle, teamId);
  const lineupIds = new Set(lineup.map(item => item.id));
  const statIds = new Set(stats.map(item => item.id));
  const lineupOnly = lineup.filter(item => !statIds.has(item.id));
  const statsOnly = stats.filter(item => !lineupIds.has(item.id));
  const accepted = [];

  for (const left of lineupOnly) {
    const bestStat = uniqueBest(statsOnly, right => candidateScore(left, right));
    if (!bestStat) continue;
    const bestLineup = uniqueBest(lineupOnly, candidate => candidateScore(candidate, bestStat.item));
    if (!bestLineup || bestLineup.item.id !== left.id) continue;
    const key = [scope.league, scope.season, teamId, left.id, bestStat.item.id].join('|');
    accepted.push({
      aliasPlayerId: left.id,
      aliasProviderId: left.providerId,
      aliasName: left.name,
      canonicalPlayerId: bestStat.item.id,
      canonicalProviderId: bestStat.item.providerId,
      canonicalName: bestStat.item.name,
      lineupRole: left.role,
      statsRole: bestStat.item.role,
      lineupNumber: left.number,
      statsMinutes: bestStat.item.minutes,
      score: bestStat.score,
      confidence: bestStat.score === 100 ? 'exact_name' : 'surname_and_first_initial',
      alreadyReviewed: aliases.has(key),
    });
  }

  const acceptedLineupIds = new Set(accepted.map(item => item.aliasPlayerId));
  const acceptedStatIds = new Set(accepted.map(item => item.canonicalPlayerId));
  return {
    teamId,
    teamName: teamName(bundle, teamId),
    lineupCount: lineup.length,
    playerStatsCount: stats.length,
    candidates: accepted,
    unresolvedLineupOnly: lineupOnly.filter(item => !acceptedLineupIds.has(item.id)),
    unresolvedStatsOnly: statsOnly.filter(item => !acceptedStatIds.has(item.id)),
  };
}

function inspectFixture(raw, observedAt, aliases) {
  const bundle = normalizeFixtureBundle(raw, { fetchedAt: observedAt, revision: 1 });
  const scope = {
    league: bundle.competition.providerId,
    season: bundle.season.providerSeason,
  };
  const teamIds = [bundle.fixture.teams.home.id, bundle.fixture.teams.away.id];
  const teams = teamIds.map(teamId => inspectTeam(bundle, teamId, scope, aliases));
  const lineupEntries = bundle.lineups.flatMap(item => [
    ...item.startXI.map(player => player.id),
    ...item.substitutes.map(player => player.id),
  ]);
  const lineupIds = new Set(lineupEntries);
  const statIds = new Set(bundle.playerStats.map(item => item.playerId));
  const appearanceUnion = new Set([...lineupIds, ...statIds]);
  const candidates = teams.flatMap(item => item.candidates);
  return {
    fixtureId: bundle.fixture.id,
    providerFixtureId: bundle.fixture.providerId,
    competitionId: bundle.fixture.competitionId,
    seasonId: bundle.fixture.seasonId,
    dateJst: bundle.fixture.dateJst,
    teams,
    counts: {
      lineupEntries: lineupEntries.length,
      playerStats: bundle.playerStats.length,
      appearanceUnion: appearanceUnion.size,
      projectedAfterCandidates: appearanceUnion.size - candidates.length,
    },
  };
}

function numericDirectories(root, expression) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && expression.test(entry.name))
    .map(entry => ({ name: entry.name, id: Number(expression.exec(entry.name)[1]) }))
    .sort((a, b) => a.id - b.id);
}

function numericFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d+\.json$/.test(entry.name))
    .map(entry => ({ name: entry.name, id: Number(entry.name.slice(0, -5)) }))
    .sort((a, b) => a.id - b.id);
}

function scanSnapshot(options) {
  const snapshotRoot = path.resolve(options.snapshotRoot);
  const latest = readJson(path.resolve(options.latest));
  const evidence = readJson(path.resolve(options.evidence));
  if (latest.snapshotId !== evidence.snapshotId
    || (evidence.playerAliases || []).some(rule => rule.observedAt !== latest.completedAt)) {
    fail('Diagnostic inputs do not describe the same reviewed snapshot observation.');
  }
  const aliases = reviewedAliasMap(evidence);
  const fixtures = [];
  for (const league of numericDirectories(snapshotRoot, /^league-(\d+)$/)) {
    const completedRoot = path.join(snapshotRoot, league.name, 'completed-fixtures');
    for (const file of numericFiles(completedRoot)) {
      fixtures.push(inspectFixture(readJson(path.join(completedRoot, file.name)), latest.completedAt, aliases));
    }
  }
  const findings = fixtures.filter(item => item.teams.some(team => (
    team.candidates.length || team.unresolvedLineupOnly.length || team.unresolvedStatsOnly.length
  )));
  const candidates = findings.flatMap(item => item.teams.flatMap(team => team.candidates.map(candidate => ({
    fixtureId: item.fixtureId,
    providerFixtureId: item.providerFixtureId,
    competitionId: item.competitionId,
    seasonId: item.seasonId,
    dateJst: item.dateJst,
    teamId: team.teamId,
    teamName: team.teamName,
    ...candidate,
  }))));
  return {
    schemaVersion: REPORT_SCHEMA,
    source: {
      provider: latest.provider,
      snapshotId: latest.snapshotId,
      archiveKey: latest.archiveKey,
      archiveSha256: latest.archiveSha256,
      observedAt: latest.completedAt,
    },
    summary: {
      fixturesScanned: fixtures.length,
      fixturesWithIdentityVariance: findings.length,
      candidateCount: candidates.length,
      unreviewedCandidateCount: candidates.filter(item => !item.alreadyReviewed).length,
      unresolvedLineupOnlyCount: findings.reduce((sum, item) => sum + item.teams.reduce(
        (inner, team) => inner + team.unresolvedLineupOnly.length, 0,
      ), 0),
      unresolvedStatsOnlyCount: findings.reduce((sum, item) => sum + item.teams.reduce(
        (inner, team) => inner + team.unresolvedStatsOnly.length, 0,
      ), 0),
      rawUnionOver40FixtureCount: fixtures.filter(item => item.counts.appearanceUnion > 40).length,
      projectedOver40FixtureCount: fixtures.filter(item => item.counts.projectedAfterCandidates > 40).length,
      lineupOver40FixtureCount: fixtures.filter(item => item.counts.lineupEntries > 40).length,
      playerStatsOver40FixtureCount: fixtures.filter(item => item.counts.playerStats > 40).length,
    },
    candidates,
    findings,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['snapshot-root'] || !args.latest || !args.evidence || !args.out) {
    fail('Usage: report-player-identity-variance.js --snapshot-root DIR --latest FILE --evidence FILE --out FILE');
  }
  const report = scanSnapshot({
    snapshotRoot: args['snapshot-root'], latest: args.latest, evidence: args.evidence,
  });
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

module.exports = { REPORT_SCHEMA, candidateScore, inspectFixture, scanSnapshot };
