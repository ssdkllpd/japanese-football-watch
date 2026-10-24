'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClientFromEnv } = require('../api-football/client');
const {
  PROVIDER,
  afId,
  seasonId,
} = require('./fixture-contract');

const STANDINGS_CONTRACT_VERSION = '2.0.0';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function toUtcIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function responseArray(result) {
  return Array.isArray(result?.data?.response) ? result.data.response : [];
}

function provenance(fetchedAt) {
  return {
    source: PROVIDER,
    fetchedAt,
    verification: 'provider',
    issues: [],
  };
}

function normalizeRecordScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  return {
    played: numeric(scope.played),
    wins: numeric(scope.win),
    draws: numeric(scope.draw),
    losses: numeric(scope.lose),
    goalsFor: numeric(scope?.goals?.for),
    goalsAgainst: numeric(scope?.goals?.against),
  };
}

function normalizeStandingRow(row, fetchedAt) {
  const teamProviderId = numeric(row?.team?.id) ?? row?.team?.id ?? null;
  return {
    rank: numeric(row?.rank),
    team: {
      id: afId('team', teamProviderId),
      providerId: teamProviderId,
      name: text(row?.team?.name),
      logo: text(row?.team?.logo),
    },
    points: numeric(row?.points),
    goalDifference: numeric(row?.goalsDiff),
    form: text(row?.form),
    status: text(row?.status),
    description: text(row?.description),
    overall: normalizeRecordScope(row?.all),
    home: normalizeRecordScope(row?.home),
    away: normalizeRecordScope(row?.away),
    updatedAt: toUtcIso(row?.update),
    provenance: provenance(fetchedAt),
  };
}

function selectLeagueBlock(providerRows, options = {}) {
  const rows = Array.isArray(providerRows) ? providerRows : [];
  const expectedLeague = options.league === undefined || options.league === null ? null : String(options.league);
  const expectedSeason = options.season === undefined || options.season === null ? null : String(options.season);
  const matches = rows.filter(item => {
    const league = item?.league || {};
    if (expectedLeague !== null && String(league.id) !== expectedLeague) return false;
    if (expectedSeason !== null && String(league.season) !== expectedSeason) return false;
    return true;
  });
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one standings response, received ${matches.length}.`);
  }
  return matches[0];
}

function missingTeamIdentity(providerRows) {
  return providerRows.some(block => (block?.league?.standings || []).flat()
    .some(row => row?.team?.id === null || row?.team?.id === undefined));
}

// Only an exact name from this provider's declared competition/season may
// repair an absent ID. Ambiguous names and malformed nonempty IDs stay rejected.
function recoverStandingTeam(row, teams) {
  if (row?.team?.id !== null && row?.team?.id !== undefined) return row;
  const name = text(row?.team?.name);
  const key = value => text(value)?.normalize('NFKC').toLowerCase();
  const matches = teams.filter(team => name && key(team?.name) === key(name)
    && Number.isSafeInteger(team?.id) && team.id > 0);
  const ids = new Set(matches.map(team => team.id));
  if (ids.size !== 1) throw new Error(`Standings team ID is missing and cannot be uniquely recovered: ${name || '(unnamed)'}.`);
  return { ...row, team: { ...row.team, id: matches[0].id }, recoveredTeamId: true };
}

async function fetchStandingsTeams(client, providerRows, query) {
  if (!missingTeamIdentity(providerRows)) return [];
  const result = await client.get('teams', { league: query.league, season: query.season });
  const rows = responseArray(result);
  if (Number(result.data?.paging?.total ?? 1) !== 1
    || Number(result.data?.results ?? rows.length) !== rows.length) {
    throw new Error('Standings team catalog response is incomplete.');
  }
  return rows.map(row => row.team);
}

function normalizeStandings(providerRows, options = {}) {
  const block = selectLeagueBlock(providerRows, options);
  const league = block.league || {};
  const competitionProviderId = numeric(league.id) ?? league.id ?? null;
  const providerSeason = numeric(league.season) ?? league.season ?? null;
  const fetchedAt = toUtcIso(options.fetchedAt || new Date()) || new Date().toISOString();
  const rawGroups = Array.isArray(league.standings) ? league.standings : [];
  const groups = rawGroups.map((rawGroup, groupIndex) => {
    const rows = (Array.isArray(rawGroup) ? rawGroup : [])
      .map(row => {
        const recovered = recoverStandingTeam(row, options.teams || []);
        const normalized = normalizeStandingRow(recovered, fetchedAt);
        if (recovered.recoveredTeamId) normalized.provenance.issues.push('team_id_recovered_from_provider_team_catalog');
        return normalized;
      })
      .sort((left, right) => {
        const rankDifference = (left.rank ?? Number.MAX_SAFE_INTEGER)
          - (right.rank ?? Number.MAX_SAFE_INTEGER);
        if (rankDifference !== 0) return rankDifference;
        return String(left.team.id) < String(right.team.id) ? -1
          : String(left.team.id) > String(right.team.id) ? 1 : 0;
      });
    return {
      id: `group:${groupIndex + 1}`,
      name: text(rawGroup?.[0]?.group) || (rawGroups.length > 1 ? `Group ${groupIndex + 1}` : 'Table'),
      table: rows,
    };
  });

  return {
    contractVersion: STANDINGS_CONTRACT_VERSION,
    competition: {
      id: afId('competition', competitionProviderId),
      providerId: competitionProviderId,
      name: text(league.name),
      country: text(league.country),
      logo: text(league.logo),
      flag: text(league.flag),
    },
    season: {
      id: seasonId(competitionProviderId, providerSeason),
      competitionId: afId('competition', competitionProviderId),
      providerSeason,
      label: providerSeason === null ? null : String(providerSeason),
    },
    groups,
    sectionStates: {
      standings: { presence: groups.some(group => group.table.length) ? 'present' : 'provider_missing' },
    },
    generatedAt: fetchedAt,
    provenance: provenance(fetchedAt),
  };
}

function validateStandings(snapshot) {
  const errors = [];
  if (snapshot?.contractVersion !== STANDINGS_CONTRACT_VERSION) {
    errors.push(`contractVersion must be ${STANDINGS_CONTRACT_VERSION}`);
  }
  if (!snapshot?.competition?.id?.startsWith('af:competition:')) errors.push('competition.id is required.');
  if (!snapshot?.season?.id?.startsWith('af:season:')) errors.push('season.id is required.');
  for (const group of snapshot?.groups || []) {
    for (const row of group?.table || []) {
      if (!/^af:team:[1-9]\d*$/.test(row?.team?.id || '')) errors.push('Every standings row requires a provider-native team ID.');
    }
  }
  return errors;
}

function standingsLatestKey(competitionId, canonicalSeasonId) {
  if (!competitionId || !canonicalSeasonId) throw new Error('Competition and season IDs are required.');
  return `football/v2/competitions/${competitionId}/seasons/${canonicalSeasonId}/standings/latest.json`;
}

function standingsSnapshotKey(competitionId, canonicalSeasonId, generatedAt) {
  const timestamp = toUtcIso(generatedAt);
  if (!timestamp) throw new Error('A valid generatedAt timestamp is required.');
  const segment = timestamp.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `football/v2/competitions/${competitionId}/seasons/${canonicalSeasonId}/standings/snapshots/${segment}.json`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeStandings(outputDir, snapshot, metadata = {}) {
  const errors = validateStandings(snapshot);
  if (errors.length) throw new Error(`Standings validation failed: ${errors.join('; ')}`);
  const root = path.resolve(outputDir);
  const file = 'standings.json';
  writeJson(path.join(root, file), snapshot);
  const latestKey = standingsLatestKey(snapshot.competition.id, snapshot.season.id);
  const snapshotKey = standingsSnapshotKey(snapshot.competition.id, snapshot.season.id, snapshot.generatedAt);
  const manifest = {
    contractVersion: STANDINGS_CONTRACT_VERSION,
    competitionId: snapshot.competition.id,
    seasonId: snapshot.season.id,
    fetchedAt: snapshot.generatedAt,
    query: metadata.query || null,
    quota: metadata.quota || null,
    groupCount: snapshot.groups.length,
    rowCount: snapshot.groups.reduce((sum, group) => sum + group.table.length, 0),
    r2Objects: [
      { role: 'standings_snapshot', key: snapshotKey, file },
      { role: 'standings_latest', key: latestKey, file },
    ],
  };
  writeJson(path.join(root, 'manifest.json'), manifest);
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.league || !args.season) throw new Error('Use --league <API-Football league ID> --season <provider season>.');
  const outputDir = path.resolve(args.out || `.tmp/v2/standings-${args.league}-${args.season}`);
  const query = { league: args.league, season: args.season };
  const client = createClientFromEnv(process.env);
  const result = await client.get('standings', query);
  const teams = await fetchStandingsTeams(client, responseArray(result), query);
  const snapshot = normalizeStandings(responseArray(result), {
    teams,
    league: args.league,
    season: args.season,
    fetchedAt: new Date().toISOString(),
  });
  const manifest = writeStandings(outputDir, snapshot, { query, quota: result.quota });
  process.stdout.write(`${JSON.stringify({ outputDir, manifest }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  STANDINGS_CONTRACT_VERSION,
  fetchStandingsTeams,
  missingTeamIdentity,
  normalizeRecordScope,
  normalizeStandingRow,
  normalizeStandings,
  parseArgs,
  responseArray,
  selectLeagueBlock,
  standingsLatestKey,
  standingsSnapshotKey,
  validateStandings,
  writeStandings,
};
