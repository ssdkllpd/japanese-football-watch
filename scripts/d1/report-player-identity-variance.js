'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeFixtureBundle } = require('../v2/fixture-contract');
const {
  reconcileMissingProviderPlayerIdentities,
  reconcileReviewedPlayerAliases,
  reviewedPlayerAliasRules,
} = require('./fixture-bundle-importer');

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
    .sort((a, b) => b.score - a.score
      || String(a.item.id || a.item.name || '').localeCompare(String(b.item.id || b.item.name || ''))
      || String(a.item.occurrenceKey || '').localeCompare(String(b.item.occurrenceKey || '')));
  if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) return null;
  return ranked[0];
}

function reviewedAliasMap(evidence) {
  const result = new Map();
  for (const rule of evidence.playerAliases || []) {
    const key = reviewedAliasPairKey(
      rule.league, rule.season, rule.teamId, rule.aliasPlayerId, rule.canonicalPlayerId,
    );
    result.set(key, rule);
  }
  return result;
}

function reviewedAliasPairKey(league, season, teamId, firstPlayerId, secondPlayerId) {
  const pair = [String(firstPlayerId), String(secondPlayerId)].sort();
  return [league, season, teamId, ...pair].join('|');
}

function addIdentityObservation(map, playerId, playerName, teamId = null) {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) return;
  if (!map.has(playerId)) map.set(playerId, { names: new Set(), teamIds: new Set() });
  const observation = map.get(playerId);
  if (String(playerName || '').trim()) observation.names.add(String(playerName).trim());
  if (Number.isSafeInteger(teamId) && teamId > 0) observation.teamIds.add(`af:team:${teamId}`);
}

function leagueIdentityIndex(leagueRoot) {
  const season = new Map();
  const squad = new Map();
  const playersRoot = path.join(leagueRoot, 'players');
  if (fs.existsSync(playersRoot)) {
    const pages = fs.readdirSync(playersRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^page-\d+\.json$/.test(entry.name))
      .map(entry => entry.name).sort();
    for (const page of pages) {
      for (const row of readJson(path.join(playersRoot, page)).response || []) {
        const teamIds = (row.statistics || []).map(item => item?.team?.id)
          .filter(value => Number.isSafeInteger(value) && value > 0);
        if (!teamIds.length) addIdentityObservation(season, row?.player?.id, row?.player?.name);
        for (const teamId of teamIds) {
          addIdentityObservation(season, row?.player?.id, row?.player?.name, teamId);
        }
      }
    }
  }
  const squadsRoot = path.join(leagueRoot, 'squads');
  if (fs.existsSync(squadsRoot)) {
    const files = fs.readdirSync(squadsRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^\d+\.json$/.test(entry.name))
      .map(entry => entry.name).sort();
    for (const file of files) {
      for (const block of readJson(path.join(squadsRoot, file)).response || []) {
        const teamId = block?.team?.id;
        for (const player of block?.players || []) {
          addIdentityObservation(squad, player?.id, player?.name, teamId);
        }
      }
    }
  }
  return { season, squad };
}

function identityEvidence(index, teamId, playerId) {
  const providerId = /^af:player:(\d+)$/.exec(String(playerId || ''));
  const id = providerId ? Number(providerId[1]) : null;
  const season = id === null ? null : index.season.get(id);
  const squad = id === null ? null : index.squad.get(id);
  return {
    seasonNames: season ? [...season.names].sort() : [],
    seasonTeamIds: season ? [...season.teamIds].sort() : [],
    seasonListsFixtureTeam: season ? season.teamIds.has(teamId) : false,
    squadNames: squad ? [...squad.names].sort() : [],
    squadListsFixtureTeam: squad ? squad.teamIds.has(teamId) : false,
  };
}

function eventReferenceCount(bundle, teamId, playerId) {
  if (!/^af:player:[1-9]\d*$/.test(String(playerId || ''))) return 0;
  return bundle.events.filter(event => event.teamId === teamId
    && (event.playerId === playerId || event.relatedPlayerId === playerId)).length;
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
  return [...lineup.startXI, ...lineup.substitutes].map((player, index) => ({
    occurrenceKey: `lineup:${index}`,
    id: player.id,
    providerId: player.providerId,
    name: player.name,
    role: player.role,
    number: player.number,
    position: player.position,
  }));
}

function statPlayers(bundle, teamId) {
  return bundle.playerStats.filter(item => item.teamId === teamId).map((item, index) => ({
    occurrenceKey: `playerStats:${index}`,
    id: item.playerId,
    providerId: item.playerProviderId,
    name: item.playerName,
    role: item.starter === true ? 'starter' : 'substitute',
    minutes: item.values?.minutes ?? null,
    position: item.position,
  }));
}

function inspectTeam(bundle, teamId, scope, aliases, identityIndex) {
  const lineup = lineupPlayers(bundle, teamId);
  const stats = statPlayers(bundle, teamId);
  const validPlayerId = value => /^af:player:[1-9]\d*$/.test(String(value || ''));
  const lineupIds = new Set(lineup.map(item => item.id).filter(validPlayerId));
  const statIds = new Set(stats.map(item => item.id).filter(validPlayerId));
  const lineupOnly = lineup.filter(item => !validPlayerId(item.id) || !statIds.has(item.id));
  const statsOnly = stats.filter(item => !validPlayerId(item.id) || !lineupIds.has(item.id));
  const accepted = [];

  for (const left of lineupOnly) {
    const bestStat = uniqueBest(statsOnly, right => candidateScore(left, right));
    if (!bestStat) continue;
    const bestLineup = uniqueBest(lineupOnly, candidate => candidateScore(candidate, bestStat.item));
    if (!bestLineup || bestLineup.item.occurrenceKey !== left.occurrenceKey) continue;
    const key = reviewedAliasPairKey(
      scope.league, scope.season, teamId, left.id, bestStat.item.id,
    );
    accepted.push({
      lineupOccurrenceKey: left.occurrenceKey,
      statOccurrenceKey: bestStat.item.occurrenceKey,
      candidate: {
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
        evidence: {
          lineupIdentity: identityEvidence(identityIndex, teamId, left.id),
          playerStatsIdentity: identityEvidence(identityIndex, teamId, bestStat.item.id),
          lineupEventReferences: eventReferenceCount(bundle, teamId, left.id),
          playerStatsEventReferences: eventReferenceCount(bundle, teamId, bestStat.item.id),
        },
      },
    });
  }

  const acceptedLineupKeys = new Set(accepted.map(item => item.lineupOccurrenceKey));
  const acceptedStatKeys = new Set(accepted.map(item => item.statOccurrenceKey));
  const publicPlayer = ({ occurrenceKey, ...item }) => item;
  return {
    teamId,
    teamName: teamName(bundle, teamId),
    lineupCount: lineup.length,
    playerStatsCount: stats.length,
    candidates: accepted.map(item => item.candidate),
    unresolvedLineupOnly: lineupOnly.filter(item => !acceptedLineupKeys.has(item.occurrenceKey)).map(item => ({
      ...publicPlayer(item),
      identityEvidence: identityEvidence(identityIndex, teamId, item.id),
      eventReferences: eventReferenceCount(bundle, teamId, item.id),
    })),
    unresolvedStatsOnly: statsOnly.filter(item => !acceptedStatKeys.has(item.occurrenceKey)).map(item => ({
      ...publicPlayer(item),
      identityEvidence: identityEvidence(identityIndex, teamId, item.id),
      eventReferences: eventReferenceCount(bundle, teamId, item.id),
    })),
  };
}

function inspectFixture(
  raw,
  observedAt,
  aliases,
  identityIndex = { season: new Map(), squad: new Map() },
  aliasRules = [],
) {
  const bundle = normalizeFixtureBundle(raw, { fetchedAt: observedAt, revision: 1 });
  const reviewedBundle = reconcileReviewedPlayerAliases(bundle, aliasRules).bundle;
  const missingIdentities = reconcileMissingProviderPlayerIdentities(reviewedBundle);
  const canonicalBundle = missingIdentities.bundle;
  const scope = {
    league: bundle.competition.providerId,
    season: bundle.season.providerSeason,
  };
  const teamIds = [bundle.fixture.teams.home.id, bundle.fixture.teams.away.id];
  const teams = teamIds.map(teamId => inspectTeam(bundle, teamId, scope, aliases, identityIndex));
  const lineupEntries = bundle.lineups.flatMap(item => [
    ...item.startXI.map(player => player.id),
    ...item.substitutes.map(player => player.id),
  ]);
  const endpointKeys = (ids, prefix) => ids.map((id, index) => (
    /^af:player:[1-9]\d*$/.test(String(id || '')) ? id : `${prefix}:${index}`
  ));
  const lineupIds = endpointKeys(lineupEntries, 'missing-lineup');
  const statIds = endpointKeys(bundle.playerStats.map(item => item.playerId), 'missing-stat');
  const appearanceUnion = new Set([...lineupIds, ...statIds]);
  const reviewedLineupIds = new Set(canonicalBundle.lineups.flatMap(item => [
    ...item.startXI.map(player => player.id),
    ...item.substitutes.map(player => player.id),
  ]));
  const reviewedStatIds = new Set(canonicalBundle.playerStats.map(item => item.playerId));
  const reviewedAppearanceUnion = new Set([...reviewedLineupIds, ...reviewedStatIds]);
  const duplicateRows = entries => {
    const byPlayer = new Map();
    for (const entry of entries) {
      if (!/^af:player:[1-9]\d*$/.test(String(entry.playerId || ''))) continue;
      if (!byPlayer.has(entry.playerId)) byPlayer.set(entry.playerId, []);
      byPlayer.get(entry.playerId).push(entry);
    }
    return [...byPlayer.entries()]
      .filter(([, occurrences]) => occurrences.length > 1)
      .map(([playerId, occurrences]) => ({ playerId, occurrences }));
  };
  const duplicateLineupPlayers = duplicateRows(canonicalBundle.lineups.flatMap((lineup, lineupIndex) => [
    ...lineup.startXI.map((player, playerIndex) => ({
      playerId: player.id,
      providerId: player.providerId,
      name: player.name,
      teamId: lineup.teamId,
      role: 'starter',
      lineupIndex,
      playerIndex,
    })),
    ...lineup.substitutes.map((player, playerIndex) => ({
      playerId: player.id,
      providerId: player.providerId,
      name: player.name,
      teamId: lineup.teamId,
      role: 'substitute',
      lineupIndex,
      playerIndex,
    })),
  ]));
  const duplicatePlayerStats = duplicateRows(canonicalBundle.playerStats.map((stat, playerIndex) => ({
    playerId: stat.playerId,
    providerId: stat.playerProviderId,
    name: stat.playerName,
    teamId: stat.teamId,
    position: stat.position,
    playerIndex,
  })));
  const providerMissingCoaches = bundle.lineups.flatMap((lineup, lineupIndex) => {
    const coach = lineup.coach;
    if (!coach || (coach.providerId !== 0 && coach.providerId !== null
      && coach.id !== 'af:coach:0' && coach.id !== null)) return [];
    return [{
      fixtureId: bundle.fixture.id,
      teamId: lineup.teamId,
      lineupIndex,
      coachId: coach.id,
      providerId: coach.providerId,
      name: coach.name,
      photo: coach.photo,
    }];
  });
  const candidates = teams.flatMap(item => item.candidates);
  return {
    fixtureId: bundle.fixture.id,
    providerFixtureId: bundle.fixture.providerId,
    competitionId: bundle.fixture.competitionId,
    seasonId: bundle.fixture.seasonId,
    dateJst: bundle.fixture.dateJst,
    teams,
    duplicateLineupPlayers,
    duplicatePlayerStats,
    providerMissingCoaches,
    counts: {
      lineupEntries: lineupEntries.length,
      playerStats: bundle.playerStats.length,
      appearanceUnion: appearanceUnion.size,
      projectedAfterCandidates: appearanceUnion.size - candidates.length,
      reviewedAppearanceUnion: reviewedAppearanceUnion.size,
      providerMissingPlayerIdentityOmissions: missingIdentities.omissions.length,
      duplicateLineupPlayerIdentityCount: duplicateLineupPlayers.length,
      duplicateLineupEntryCount: duplicateLineupPlayers.reduce(
        (sum, item) => sum + item.occurrences.length, 0,
      ),
      duplicatePlayerStatsIdentityCount: duplicatePlayerStats.length,
      duplicatePlayerStatsRowCount: duplicatePlayerStats.reduce(
        (sum, item) => sum + item.occurrences.length, 0,
      ),
      providerMissingCoachIdentityCount: providerMissingCoaches.length,
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
  const aliasRules = reviewedPlayerAliasRules(evidence);
  const fixtures = [];
  for (const league of numericDirectories(snapshotRoot, /^league-(\d+)$/)) {
    const leagueRoot = path.join(snapshotRoot, league.name);
    const completedRoot = path.join(leagueRoot, 'completed-fixtures');
    const identityIndex = leagueIdentityIndex(leagueRoot);
    for (const file of numericFiles(completedRoot)) {
      fixtures.push(inspectFixture(
        readJson(path.join(completedRoot, file.name)), latest.completedAt, aliases, identityIndex, aliasRules,
      ));
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
  const endpointDuplicates = fixtures.filter(item => (
    item.duplicateLineupPlayers.length || item.duplicatePlayerStats.length
  )).map(item => ({
    fixtureId: item.fixtureId,
    providerFixtureId: item.providerFixtureId,
    competitionId: item.competitionId,
    seasonId: item.seasonId,
    dateJst: item.dateJst,
    duplicateLineupPlayers: item.duplicateLineupPlayers,
    duplicatePlayerStats: item.duplicatePlayerStats,
  }));
  const providerMissingCoaches = fixtures.flatMap(item => item.providerMissingCoaches.map(coach => ({
    providerFixtureId: item.providerFixtureId,
    competitionId: item.competitionId,
    seasonId: item.seasonId,
    dateJst: item.dateJst,
    ...coach,
  })));
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
      providerMissingPlayerIdentityFixtureCount: fixtures.filter(
        item => item.counts.providerMissingPlayerIdentityOmissions > 0,
      ).length,
      providerMissingPlayerIdentityOmissionCount: fixtures.reduce(
        (sum, item) => sum + item.counts.providerMissingPlayerIdentityOmissions, 0,
      ),
      rawUnionOver40FixtureCount: fixtures.filter(item => item.counts.appearanceUnion > 40).length,
      projectedOver40FixtureCount: fixtures.filter(item => item.counts.projectedAfterCandidates > 40).length,
      reviewedOver40FixtureCount: fixtures.filter(item => item.counts.reviewedAppearanceUnion > 40).length,
      maxReviewedAppearanceUnion: Math.max(0, ...fixtures.map(item => item.counts.reviewedAppearanceUnion)),
      lineupOver40FixtureCount: fixtures.filter(item => item.counts.lineupEntries > 40).length,
      maxLineupEntries: Math.max(0, ...fixtures.map(item => item.counts.lineupEntries)),
      playerStatsOver40FixtureCount: fixtures.filter(item => item.counts.playerStats > 40).length,
      maxPlayerStats: Math.max(0, ...fixtures.map(item => item.counts.playerStats)),
      endpointDuplicateFixtureCount: endpointDuplicates.length,
      duplicateLineupPlayerIdentityCount: fixtures.reduce(
        (sum, item) => sum + item.counts.duplicateLineupPlayerIdentityCount, 0,
      ),
      duplicateLineupEntryCount: fixtures.reduce(
        (sum, item) => sum + item.counts.duplicateLineupEntryCount, 0,
      ),
      duplicatePlayerStatsIdentityCount: fixtures.reduce(
        (sum, item) => sum + item.counts.duplicatePlayerStatsIdentityCount, 0,
      ),
      duplicatePlayerStatsRowCount: fixtures.reduce(
        (sum, item) => sum + item.counts.duplicatePlayerStatsRowCount, 0,
      ),
      providerMissingCoachIdentityFixtureCount:
        new Set(providerMissingCoaches.map(item => item.fixtureId)).size,
      providerMissingCoachIdentityRowCount: providerMissingCoaches.length,
    },
    candidates,
    endpointDuplicates,
    providerMissingCoaches,
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
