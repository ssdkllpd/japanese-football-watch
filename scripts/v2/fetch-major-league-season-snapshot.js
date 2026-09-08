'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createClientFromEnv } = require('../api-football/client');

const FINAL_STATUSES = new Set(['FT', 'AET', 'PEN']);
const DEFAULT_RESERVE = 50;
const DEFAULT_INTERVAL_MS = 300;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function responseArray(result) {
  return Array.isArray(result?.data?.response) ? result.data.response : [];
}

function parseTargets(config) {
  if (!config || config.schemaVersion !== 'jfw-d1-admin-ingest-plan/1' || !Array.isArray(config.standings)) {
    throw new Error('Major-league config must be a jfw-d1-admin-ingest-plan/1 standings plan.');
  }
  const seen = new Set();
  return config.standings.map(item => {
    const competition = /^af:competition:(\d+)$/.exec(String(item.competitionId || ''));
    const season = /^af:season:(\d+):(\d+)$/.exec(String(item.seasonId || ''));
    if (!competition || !season || competition[1] !== season[1]) {
      throw new Error(`Invalid competition/season target: ${JSON.stringify(item)}`);
    }
    if (seen.has(item.competitionId)) throw new Error(`Duplicate competition target: ${item.competitionId}`);
    seen.add(item.competitionId);
    return {
      competitionId: item.competitionId,
      seasonId: item.seasonId,
      league: Number(competition[1]),
      season: Number(season[2]),
    };
  });
}

function errorRecord(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || 'Unknown API-Football error',
    status: error?.status ?? null,
    apiErrors: error?.apiErrors ?? null,
  };
}

class RequestBudget {
  constructor(options = {}) {
    this.reserve = Number(options.reserve ?? DEFAULT_RESERVE);
    this.minimumIntervalMs = Number(options.minimumIntervalMs ?? DEFAULT_INTERVAL_MS);
    this.wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.now = options.now || Date.now;
    this.lastRequestAt = null;
    this.requestCount = 0;
    this.dailyRemaining = null;
    this.dailyLimit = null;
    this.minuteRemaining = null;
    this.minuteLimit = null;
  }

  async get(client, endpoint, parameters) {
    if (this.dailyRemaining !== null && this.dailyRemaining <= this.reserve) {
      throw new Error(`API-Football daily reserve reached (${this.dailyRemaining} remaining).`);
    }
    if (this.lastRequestAt !== null) {
      const delay = this.minimumIntervalMs - (this.now() - this.lastRequestAt);
      if (delay > 0) await this.wait(delay);
    }
    try {
      const result = await client.get(endpoint, parameters);
      this.requestCount += 1;
      this.lastRequestAt = this.now();
      this.updateQuota(result.quota);
      return result;
    } catch (error) {
      this.requestCount += 1;
      this.lastRequestAt = this.now();
      this.updateQuota(error?.quota);
      throw error;
    }
  }

  updateQuota(quota) {
    if (!quota) return;
    for (const key of ['dailyRemaining', 'dailyLimit', 'minuteRemaining', 'minuteLimit']) {
      if (quota[key] !== null && quota[key] !== undefined) this[key] = quota[key];
    }
  }

  summary() {
    return {
      requestsUsed: this.requestCount,
      dailyLimit: this.dailyLimit,
      dailyRemaining: this.dailyRemaining,
      minuteLimit: this.minuteLimit,
      minuteRemaining: this.minuteRemaining,
      reserve: this.reserve,
    };
  }
}

async function fetchPagedPlayers(client, budget, target, leagueDir) {
  let page = 1;
  let totalPages = 1;
  let playerRows = 0;
  const playerIds = new Set();
  do {
    const result = await budget.get(client, 'players', {
      league: target.league,
      season: target.season,
      page,
    });
    const rows = responseArray(result);
    writeJson(path.join(leagueDir, 'players', `page-${page}.json`), result.data);
    for (const row of rows) {
      const id = row?.player?.id;
      if (Number.isInteger(id)) playerIds.add(id);
    }
    playerRows += rows.length;
    const reportedTotal = Number(result?.data?.paging?.total);
    totalPages = Number.isInteger(reportedTotal) && reportedTotal > 0 ? reportedTotal : page;
    page += 1;
  } while (page <= totalPages);
  return { pages: totalPages, rows: playerRows, uniquePlayers: playerIds.size };
}

function missingEmbeddedSections(fixture) {
  const sections = [
    ['events', 'fixtures/events'],
    ['lineups', 'fixtures/lineups'],
    ['players', 'fixtures/players'],
    ['statistics', 'fixtures/statistics'],
  ];
  return sections.filter(([key]) => !Array.isArray(fixture?.[key]));
}

async function fetchCompletedFixtureDetail(client, budget, fixtureId, fixtureDir) {
  const basic = await budget.get(client, 'fixtures', { id: fixtureId, timezone: 'Asia/Tokyo' });
  const fixture = responseArray(basic)[0];
  if (!fixture) throw new Error(`Completed fixture ${fixtureId} was not returned by API-Football.`);
  const fallbackEndpoints = [];
  for (const [section, endpoint] of missingEmbeddedSections(fixture)) {
    const result = await budget.get(client, endpoint, { fixture: fixtureId });
    fixture[section] = responseArray(result);
    fallbackEndpoints.push(endpoint);
  }
  writeJson(path.join(fixtureDir, `${fixtureId}.json`), fixture);
  return { fallbackEndpoints };
}

async function collectLeague(client, budget, target, outputRoot, options = {}) {
  const leagueDir = path.join(outputRoot, `league-${target.league}`);
  fs.mkdirSync(leagueDir, { recursive: true });
  const baseQueries = [
    ['league', 'leagues', { id: target.league, season: target.season }],
    ['standings', 'standings', { league: target.league, season: target.season }],
    ['teams', 'teams', { league: target.league, season: target.season }],
    ['fixtures', 'fixtures', { league: target.league, season: target.season, timezone: 'Asia/Tokyo' }],
  ];
  const results = {};
  for (const [name, endpoint, parameters] of baseQueries) {
    results[name] = await budget.get(client, endpoint, parameters);
    writeJson(path.join(leagueDir, `${name}.json`), results[name].data);
  }

  const teams = responseArray(results.teams)
    .map(item => item?.team)
    .filter(team => Number.isInteger(team?.id));
  if (!teams.length) throw new Error(`League ${target.league} returned no teams.`);
  const fixtures = responseArray(results.fixtures);
  if (!fixtures.length) throw new Error(`League ${target.league} returned no fixtures.`);

  const players = await fetchPagedPlayers(client, budget, target, leagueDir);
  let squadPlayers = 0;
  let coaches = 0;
  for (const team of teams) {
    const squad = await budget.get(client, 'players/squads', { team: team.id });
    const coach = await budget.get(client, 'coachs', { team: team.id });
    const statistics = await budget.get(client, 'teams/statistics', {
      league: target.league,
      season: target.season,
      team: team.id,
    });
    writeJson(path.join(leagueDir, 'squads', `${team.id}.json`), squad.data);
    writeJson(path.join(leagueDir, 'coaches', `${team.id}.json`), coach.data);
    writeJson(path.join(leagueDir, 'team-statistics', `${team.id}.json`), statistics.data);
    squadPlayers += responseArray(squad).reduce((count, item) => count + (Array.isArray(item?.players) ? item.players.length : 0), 0);
    coaches += responseArray(coach).length;
  }

  const completed = fixtures.filter(item => FINAL_STATUSES.has(String(item?.fixture?.status?.short || '').toUpperCase()));
  let detailFallbackRequests = 0;
  if (options.completedDetails !== false) {
    for (let index = 0; index < completed.length; index += 1) {
      const fixtureId = completed[index]?.fixture?.id;
      if (!Number.isInteger(fixtureId)) throw new Error(`League ${target.league} contains a completed fixture without an id.`);
      const detail = await fetchCompletedFixtureDetail(
        client,
        budget,
        fixtureId,
        path.join(leagueDir, 'completed-fixtures'),
      );
      detailFallbackRequests += detail.fallbackEndpoints.length;
      if ((index + 1) % 25 === 0 || index + 1 === completed.length) {
        process.stdout.write(`League ${target.league}: completed detail ${index + 1}/${completed.length}\n`);
      }
    }
  }

  const leagueResponse = responseArray(results.league)[0];
  const standingGroups = responseArray(results.standings)[0]?.league?.standings || [];
  return {
    competitionId: target.competitionId,
    seasonId: target.seasonId,
    league: target.league,
    season: target.season,
    name: leagueResponse?.league?.name ?? null,
    teams: teams.length,
    fixtures: fixtures.length,
    completedFixtures: completed.length,
    completedFixtureDetails: options.completedDetails === false ? 0 : completed.length,
    detailFallbackRequests,
    standingsRows: standingGroups.reduce((count, group) => count + (Array.isArray(group) ? group.length : 0), 0),
    playerPages: players.pages,
    playerRows: players.rows,
    uniquePlayers: players.uniquePlayers,
    squadPlayers,
    coaches,
  };
}

async function collectSnapshot(options) {
  const outputRoot = path.resolve(options.outputRoot);
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  const targets = parseTargets(options.config);
  const budget = options.budget || new RequestBudget({
    reserve: options.reserve,
    minimumIntervalMs: options.minimumIntervalMs,
  });
  const startedAt = new Date(options.startedAt || Date.now()).toISOString();
  const leagues = [];
  for (const target of targets) {
    process.stdout.write(`Collecting league ${target.league}, season ${target.season}\n`);
    leagues.push(await collectLeague(options.client, budget, target, outputRoot, options));
  }
  const completedAt = new Date(options.completedAt || Date.now()).toISOString();
  const snapshotId = completedAt.replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
  const manifest = {
    schemaVersion: 'jfw-api-football-major-leagues-snapshot/1',
    provider: 'api-football',
    apiVersion: 'v3',
    startedAt,
    completedAt,
    snapshotId,
    complete: leagues.length === targets.length,
    targetCount: targets.length,
    leagues,
    totals: {
      teams: leagues.reduce((sum, item) => sum + item.teams, 0),
      fixtures: leagues.reduce((sum, item) => sum + item.fixtures, 0),
      completedFixtures: leagues.reduce((sum, item) => sum + item.completedFixtures, 0),
      completedFixtureDetails: leagues.reduce((sum, item) => sum + item.completedFixtureDetails, 0),
      standingsRows: leagues.reduce((sum, item) => sum + item.standingsRows, 0),
      playerRows: leagues.reduce((sum, item) => sum + item.playerRows, 0),
      uniquePlayersByLeague: leagues.reduce((sum, item) => sum + item.uniquePlayers, 0),
      squadPlayers: leagues.reduce((sum, item) => sum + item.squadPlayers, 0),
      coaches: leagues.reduce((sum, item) => sum + item.coaches, 0),
    },
    quota: budget.summary(),
    r2: {
      archiveKey: `audit/api-football/v3/major-leagues/2026/snapshots/${snapshotId}.tar.gz`,
      manifestKey: `audit/api-football/v3/major-leagues/2026/snapshots/${snapshotId}.manifest.json`,
      latestKey: 'audit/api-football/v3/major-leagues/2026/latest.json',
    },
  };
  writeJson(path.join(outputRoot, 'manifest.json'), manifest);
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(args.config || 'config/d1-major-leagues-2026.json');
  const outputRoot = path.resolve(args.out || '.tmp/api-football-major-leagues');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const client = createClientFromEnv(process.env);
  const manifest = await collectSnapshot({
    client,
    config,
    outputRoot,
    reserve: Number(args.reserve ?? DEFAULT_RESERVE),
    minimumIntervalMs: Number(args.interval ?? DEFAULT_INTERVAL_MS),
    completedDetails: args['skip-completed-details'] !== true,
  });
  const digest = createHash('sha256').update(fs.readFileSync(path.join(outputRoot, 'manifest.json'))).digest('hex');
  process.stdout.write(`${JSON.stringify({ manifestDigest: digest, ...manifest }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ error: errorRecord(error) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  FINAL_STATUSES,
  RequestBudget,
  collectLeague,
  collectSnapshot,
  errorRecord,
  fetchCompletedFixtureDetail,
  fetchPagedPlayers,
  missingEmbeddedSections,
  parseArgs,
  parseTargets,
  responseArray,
  safeSegment,
};
