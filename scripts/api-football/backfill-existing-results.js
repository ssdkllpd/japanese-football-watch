'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClientFromEnv, ApiFootballError } = require('./client');
const { FINAL_FIXTURE_STATUSES, mapFixtureToSchemaV2 } = require('./schema-v2-mapper');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_MANIFEST_PATH = path.join(ROOT, 'config', 'api-football-existing-results.json');
const DEFAULT_PROVIDER_CONFIG_PATH = path.join(ROOT, 'config', 'api-football.json');
const DEFAULT_DATA_PATH = path.join(ROOT, 'data.json');
const GENERATED_FRAGMENT = 'api-football-existing-results.json';

class QuotaStop extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaStop';
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath, fallback) {
  return fs.existsSync(filePath) ? readJson(filePath) : fallback;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function textKey(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of textKey(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stablePlayerId(name) {
  return `jp-${stableHash(name)}`;
}

function matchKeyOf(match) {
  return [match?.league, match?.ko, match?.match].join('|');
}

function mergeProviderIds(current, incoming) {
  const output = { ...(current || {}) };
  for (const [provider, identifiers] of Object.entries(incoming || {})) {
    output[provider] = { ...(output[provider] || {}), ...(identifiers || {}) };
  }
  return output;
}

function mergeCurrentData(root = ROOT, season = '2026-27') {
  const data = readJson(path.join(root, 'data.json'));
  data.matches = data.matches || [];
  data.players = data.players || [];

  const backfillDirectory = path.join(root, 'data', season, 'backfill');
  const index = readJson(path.join(backfillDirectory, 'index.json'));
  for (const fragmentName of index.fragments || []) {
    const fragment = readJson(path.join(backfillDirectory, fragmentName));
    for (const update of fragment.matchUpdates || []) {
      const found = data.matches.find(match =>
        (update.matchId && match.matchId === update.matchId) ||
        (update.matchKey && matchKeyOf(match) === update.matchKey)
      );
      const { matchKey, addIfMissing, addToTopMatches, ...clean } = update;
      if (found) Object.assign(found, clean);
      else if (addIfMissing !== false) data.matches.push({ ...clean });
    }

    for (const update of fragment.playerUpdates || []) {
      let player = data.players.find(candidate =>
        (update.playerId && candidate.playerId === update.playerId) || candidate.name === update.name
      );
      if (!player) {
        player = { name: update.name, stats: {} };
        data.players.push(player);
      }
      const { providerIds, stats, ...metadata } = update;
      Object.assign(player, metadata);
      if (providerIds) player.providerIds = mergeProviderIds(player.providerIds, providerIds);
      if (!player.stats && stats) player.stats = { ...stats };
    }
  }

  for (const player of data.players) {
    if (player?.name && !player.playerId) player.playerId = stablePlayerId(player.name);
  }
  return data;
}

function parseStoredScore(matchLabel) {
  const match = String(matchLabel || '').match(/^(.*?)\s+(\d+)\s*[-–]\s*(\d+)\s+(.+)$/u);
  if (!match) return null;
  return {
    homeName: match[1].trim(),
    homeGoals: Number(match[2]),
    awayGoals: Number(match[3]),
    awayName: match[4].replace(/\s*[（(]PK\b.*$/iu, '').trim(),
  };
}

function eligibleMatches(data, selection = {}) {
  return (data.matches || []).filter(match => {
    if (selection.status && match.status !== selection.status) return false;
    if (selection.requiresScore && !parseStoredScore(match.match)) return false;
    return true;
  });
}

function splitPlayerNames(value) {
  return String(value || '').split(/\s*\/\s*/u).map(name => name.trim()).filter(Boolean);
}

function selectionSignature(target) {
  return [target.matchId, target.fixtureDate, target.ko, target.match, target.status].join('|');
}

function buildTargets(data, manifest) {
  const eligible = eligibleMatches(data, manifest.selection);
  const eligibleById = new Map();
  const discoveryGroupByMatchId = new Map();
  for (const group of manifest.fixtureDiscoveryGroups || []) {
    if (!group.key || !group.search || !(group.aliases || []).length) {
      throw new Error('Every fixture discovery group requires key, search and aliases.');
    }
    for (const matchId of group.matchIds || []) {
      if (discoveryGroupByMatchId.has(matchId)) {
        throw new Error(`Fixture discovery group is duplicated for ${matchId}.`);
      }
      discoveryGroupByMatchId.set(matchId, group);
    }
  }
  for (const match of eligible) {
    if (!match.matchId) throw new Error(`Eligible match is missing matchId: ${match.match}`);
    if (eligibleById.has(match.matchId)) throw new Error(`Duplicate eligible matchId: ${match.matchId}`);
    eligibleById.set(match.matchId, match);
  }

  const configuredIds = new Set();
  const targets = [];
  for (const configured of manifest.fixtures || []) {
    if (!configured.matchId || configuredIds.has(configured.matchId)) {
      throw new Error(`Duplicate or empty configured matchId: ${configured.matchId || '(empty)'}`);
    }
    configuredIds.add(configured.matchId);
    const stored = eligibleById.get(configured.matchId);
    if (!stored) throw new Error(`Configured match is not an existing verified result: ${configured.matchId}`);
    const score = parseStoredScore(stored.match);
    targets.push({
      ...configured,
      ...stored,
      fixtureDate: configured.fixtureDate,
      homeAliases: configured.homeAliases || [],
      awayAliases: configured.awayAliases || [],
      score,
      playerNames: splitPlayerNames(stored.players),
      providerLeagueId: manifest.competitionIds?.[stored.league] ?? null,
      discoveryGroup: discoveryGroupByMatchId.get(configured.matchId) || null,
    });
    if (targets.at(-1).providerLeagueId === null) {
      throw new Error(`API-Football competition id is not configured for ${stored.league}.`);
    }
    if (!targets.at(-1).discoveryGroup) {
      throw new Error(`Fixture discovery group is not configured for ${configured.matchId}.`);
    }
  }

  const omitted = [...eligibleById.keys()].filter(matchId => !configuredIds.has(matchId));
  if (omitted.length && manifest.selection?.allowUnlistedMatches !== true) {
    throw new Error(`Verified result manifest omits ${omitted.length} match(es): ${omitted.join(', ')}`);
  }
  return targets;
}

function normalizeProviderName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function aliasMatches(value, aliases) {
  const normalized = normalizeProviderName(value);
  return !!normalized && (aliases || []).some(alias => normalizeProviderName(alias) === normalized);
}

function finalFixture(fixture) {
  return FINAL_FIXTURE_STATUSES.has(String(fixture?.fixture?.status?.short || '').toUpperCase());
}

function fixtureMatchesTarget(fixture, target) {
  if (!finalFixture(fixture)) return false;
  const homeGoals = fixture?.goals?.home;
  const awayGoals = fixture?.goals?.away;
  if (homeGoals === null || homeGoals === undefined || Number(homeGoals) !== target.score.homeGoals) return false;
  if (awayGoals === null || awayGoals === undefined || Number(awayGoals) !== target.score.awayGoals) return false;
  if (!aliasMatches(fixture?.teams?.home?.name, target.homeAliases)) return false;
  if (!aliasMatches(fixture?.teams?.away?.name, target.awayAliases)) return false;
  return true;
}

function compactFixture(fixture) {
  return {
    fixture: {
      id: fixture?.fixture?.id ?? null,
      referee: fixture?.fixture?.referee ?? null,
      timezone: fixture?.fixture?.timezone ?? null,
      date: fixture?.fixture?.date ?? null,
      timestamp: fixture?.fixture?.timestamp ?? null,
      venue: fixture?.fixture?.venue ?? null,
      status: fixture?.fixture?.status ?? null,
    },
    league: fixture?.league ?? null,
    teams: fixture?.teams ?? null,
    goals: fixture?.goals ?? null,
    score: fixture?.score ?? null,
  };
}

function emptyState(manifest) {
  return {
    schemaVersion: 1,
    provider: 'api-football',
    mode: 'existing_verified_results_only',
    season: manifest.season,
    targetCount: (manifest.fixtures || []).length,
    fixtureResolutions: {},
    teamResolutions: {},
    playerResolutions: {},
    completedMatchIds: [],
    pendingMatchIds: [],
    unresolvedMatchIds: [],
    lastRun: null,
    security: {
      apiKeyPersisted: false,
      rawResponsesPersisted: false,
      scheduledFixturesRequested: false,
      unlistedFixturesPersisted: false,
      fixedManifestDateDiscoveryUsed: true,
      teamLastDiscoveryUsed: false,
    },
  };
}

function emptyFragment(manifest) {
  return {
    schemaVersion: 2,
    season: manifest.season,
    updated: null,
    provider: 'api-football',
    sources: {},
    matchUpdates: [],
    playerUpdates: [],
    playerMatchStats: [],
    gaResultsAdd: [],
  };
}

function rowKey(row, kind) {
  if (kind === 'matchUpdates') return row.matchId;
  if (kind === 'playerUpdates') return row.playerId || row.name;
  if (kind === 'playerMatchStats') return row.recordId || `${row.matchId}|${row.playerId || row.playerName || row.player}`;
  if (kind === 'gaResultsAdd') return `${row.matchId}|${row.playerId || row.player}`;
  return null;
}

function mergeFragment(base, incoming) {
  const output = { ...base, ...incoming };
  output.sources = { ...(base.sources || {}), ...(incoming.sources || {}) };
  for (const kind of ['matchUpdates', 'playerUpdates', 'playerMatchStats', 'gaResultsAdd']) {
    const rows = new Map();
    for (const row of [...(base[kind] || []), ...(incoming[kind] || [])]) {
      const key = rowKey(row, kind);
      if (!key) continue;
      const previous = rows.get(key) || {};
      const merged = { ...previous, ...row };
      if (kind === 'playerUpdates') merged.providerIds = mergeProviderIds(previous.providerIds, row.providerIds);
      rows.set(key, merged);
    }
    output[kind] = [...rows.values()];
  }
  return output;
}

function providerPeople(fixture) {
  const people = new Map();
  function observe(player, team) {
    const id = player?.id;
    if (id === null || id === undefined) return;
    const key = String(id);
    if (!people.has(key)) people.set(key, { providerPlayerId: id, names: new Set(), teamIds: new Set() });
    const person = people.get(key);
    if (player?.name) person.names.add(player.name);
    if (team?.id !== null && team?.id !== undefined) person.teamIds.add(String(team.id));
  }
  for (const lineup of fixture.lineups || []) {
    for (const item of [...(lineup.startXI || []), ...(lineup.substitutes || [])]) observe(item?.player, lineup.team);
  }
  for (const teamBlock of fixture.players || []) {
    for (const item of teamBlock.players || []) observe(item?.player, teamBlock.team);
  }
  for (const event of fixture.events || []) {
    observe(event?.player, event?.team);
    observe(event?.assist, event?.team);
  }
  return people;
}

function resolvedTrackedPlayers(data, target, fixture, manifest, state, updated) {
  const people = providerPeople(fixture);
  const playersByName = new Map((data.players || []).map(player => [player.name, player]));
  const unresolved = [];

  for (const name of target.playerNames) {
    let local = playersByName.get(name);
    if (!local) {
      local = { name, playerId: stablePlayerId(name) };
      data.players.push(local);
      playersByName.set(name, local);
    }
    const existingId = local?.providerIds?.apiFootball?.player ?? state.playerResolutions?.[name]?.providerPlayerId;
    if (existingId !== null && existingId !== undefined) {
      state.playerResolutions[name] = {
        providerPlayerId: existingId,
        resolvedAt: state.playerResolutions?.[name]?.resolvedAt || updated,
        method: state.playerResolutions?.[name]?.method || 'persisted_provider_id',
      };
      continue;
    }

    const aliases = manifest.playerAliases?.[name] || [];
    if (!aliases.length) {
      unresolved.push({ name, reason: 'aliases_not_configured' });
      continue;
    }
    const candidates = [...people.values()].filter(person =>
      [...person.names].some(providerName => aliasMatches(providerName, aliases))
    );
    if (candidates.length !== 1) {
      unresolved.push({ name, reason: candidates.length ? 'ambiguous_provider_players' : 'not_observed_in_fixture' });
      continue;
    }
    state.playerResolutions[name] = {
      providerPlayerId: candidates[0].providerPlayerId,
      resolvedAt: updated,
      method: 'explicit_alias_in_expected_fixture',
    };
  }

  const byProviderId = new Map();
  const tracked = [];
  for (const player of data.players || []) {
    const providerPlayerId = player?.providerIds?.apiFootball?.player ?? state.playerResolutions?.[player.name]?.providerPlayerId;
    if (providerPlayerId === null || providerPlayerId === undefined) continue;
    const key = String(providerPlayerId);
    if (byProviderId.has(key) && byProviderId.get(key) !== player.name) {
      throw new Error(`API-Football player ${key} resolved to both ${byProviderId.get(key)} and ${player.name}.`);
    }
    byProviderId.set(key, player.name);
    tracked.push({
      ...player,
      playerId: player.playerId || stablePlayerId(player.name),
      apiFootballPlayerId: providerPlayerId,
    });
  }
  return { tracked, unresolved };
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function safeApiErrorDetails(error, apiKey = process.env.API_FOOTBALL_KEY) {
  if (!(error instanceof ApiFootballError)) return null;
  let serialized;
  try {
    serialized = JSON.stringify(error.apiErrors ?? null);
  } catch {
    serialized = 'null';
  }
  if (apiKey) serialized = serialized.split(String(apiKey)).join('[REDACTED]');
  if (serialized.length > 2000) serialized = JSON.stringify(`${serialized.slice(0, 1990)}…`);
  let apiErrors = null;
  try { apiErrors = JSON.parse(serialized); } catch { apiErrors = 'unparseable_api_error'; }
  return {
    status: error.status,
    apiErrors,
  };
}

class RequestBudget {
  constructor(providerConfig, options = {}) {
    const quota = providerConfig.quota || {};
    this.reserve = Number(options.reserve ?? quota.reserveForTrackedFixtures ?? 20);
    this.maxRequests = Number(options.maxRequests ??
      Math.max(1, Number(quota.configuredDailyBudget || 100) - this.reserve));
    this.perMinuteLimit = Number(quota.configuredPerMinuteLimit || 10);
    this.minimumIntervalMs = Number(options.minimumIntervalMs ??
      quota.minimumRequestIntervalMs ??
      Math.ceil(60000 / Math.max(1, this.perMinuteLimit)) + 100);
    this.wait = options.wait || sleep;
    this.now = options.now || Date.now;
    this.requestCount = 0;
    this.dailyRemaining = null;
    this.minuteRemaining = null;
    this.lastRequestAt = null;
    this.stoppedReason = null;
  }

  hasCapacity(count = 1) {
    if (this.requestCount + count > this.maxRequests) return false;
    if (this.dailyRemaining !== null && this.dailyRemaining - count < this.reserve) return false;
    return true;
  }

  async pace() {
    if (this.lastRequestAt === null || this.minimumIntervalMs <= 0) return;
    const remaining = this.minimumIntervalMs - (this.now() - this.lastRequestAt);
    if (remaining > 0) await this.wait(remaining);
  }

  async get(client, endpoint, parameters) {
    if (!this.hasCapacity(1)) {
      this.stoppedReason = 'daily_quota_reserve';
      throw new QuotaStop('API-Football request reserve reached.');
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.pace();
      this.requestCount += 1;
      this.lastRequestAt = this.now();
      try {
        const result = await client.get(endpoint, parameters);
        this.dailyRemaining = result.quota?.dailyRemaining ?? this.dailyRemaining;
        this.minuteRemaining = result.quota?.minuteRemaining ?? this.minuteRemaining;
        return result;
      } catch (error) {
        const retryable = error instanceof ApiFootballError && [429, 499, 500].includes(error.status);
        this.dailyRemaining = error.quota?.dailyRemaining ?? this.dailyRemaining;
        this.minuteRemaining = error.quota?.minuteRemaining ?? this.minuteRemaining;
        if (!retryable || attempt > 0 || !this.hasCapacity(1)) throw error;
        await this.wait(error.status === 429 ? 65000 : 10000);
      }
    }
    throw new Error(`API-Football request failed: ${endpoint}`);
  }
}

function resolutionStillValid(resolution, target) {
  return !!resolution?.fixtureId && !!resolution?.baseFixture && resolution.signature === selectionSignature(target);
}

async function resolveFixtures(targets, client, budget, state, manifest, updated) {
  const byDate = new Map();
  for (const target of targets) {
    if (resolutionStillValid(state.fixtureResolutions?.[target.matchId], target)) continue;
    if (!byDate.has(target.fixtureDate)) byDate.set(target.fixtureDate, []);
    byDate.get(target.fixtureDate).push(target);
  }

  for (const [fixtureDate, dateTargets] of byDate) {
    if (!budget.hasCapacity(1)) {
      budget.stoppedReason = 'daily_quota_reserve';
      break;
    }
    const { data } = await budget.get(client, '/fixtures', {
      date: fixtureDate,
      timezone: manifest.timezone,
    });
    const fixtures = Array.isArray(data?.response) ? data.response : [];
    for (const target of dateTargets) {
      const candidates = fixtures.filter(fixture => fixtureMatchesTarget(fixture, target));
      if (candidates.length === 1) {
        state.fixtureResolutions[target.matchId] = {
          fixtureId: candidates[0]?.fixture?.id,
          signature: selectionSignature(target),
          fixtureDate: target.fixtureDate,
          discovery: {
            mode: 'fixed_manifest_date',
            fixtureDate,
          },
          providerHome: candidates[0]?.teams?.home?.name || null,
          providerAway: candidates[0]?.teams?.away?.name || null,
          resolvedAt: updated,
          baseFixture: compactFixture(candidates[0]),
        };
      } else {
        const scoreCandidates = fixtures.filter(fixture =>
          finalFixture(fixture) &&
          fixture?.goals?.home !== null && fixture?.goals?.home !== undefined &&
          fixture?.goals?.away !== null && fixture?.goals?.away !== undefined &&
          Number(fixture.goals.home) === target.score.homeGoals &&
          Number(fixture.goals.away) === target.score.awayGoals
        ).slice(0, 20).map(fixture => ({
          fixtureId: fixture?.fixture?.id ?? null,
          kickoff: fixture?.fixture?.date ?? null,
          league: fixture?.league?.name ?? null,
          home: fixture?.teams?.home?.name ?? null,
          away: fixture?.teams?.away?.name ?? null,
        }));
        state.fixtureResolutions[target.matchId] = {
          fixtureId: null,
          signature: selectionSignature(target),
          fixtureDate: target.fixtureDate,
          discovery: {
            mode: 'fixed_manifest_date',
            fixtureDate,
          },
          candidateCount: candidates.length,
          scoreCandidates,
          reason: candidates.length ? 'ambiguous_fixture' : 'fixture_not_found',
          resolvedAt: updated,
        };
      }
    }
  }
}

async function resolveManifestFixtureIds(targets, client, budget, state, manifest, updated) {
  for (const target of targets) {
    if (resolutionStillValid(state.fixtureResolutions?.[target.matchId], target)) continue;
    if (target.providerFixtureId === null || target.providerFixtureId === undefined) continue;
    if (!budget.hasCapacity(1)) {
      budget.stoppedReason = 'daily_quota_reserve';
      break;
    }
    const result = await budget.get(client, '/fixtures', {
      id: target.providerFixtureId,
      timezone: manifest.timezone,
    });
    const candidates = responseRows(result).filter(fixture => fixtureMatchesTarget(fixture, target));
    if (candidates.length !== 1) {
      state.fixtureResolutions[target.matchId] = {
        fixtureId: null,
        signature: selectionSignature(target),
        reason: candidates.length ? 'ambiguous_manifest_fixture_id' : 'manifest_fixture_id_not_found',
        resolvedAt: updated,
      };
      continue;
    }
    state.fixtureResolutions[target.matchId] = {
      fixtureId: candidates[0].fixture.id,
      signature: selectionSignature(target),
      fixtureDate: target.fixtureDate,
      providerHome: candidates[0]?.teams?.home?.name || null,
      providerAway: candidates[0]?.teams?.away?.name || null,
      resolvedAt: updated,
      discovery: {
        mode: 'manifest_fixture_id',
      },
      baseFixture: compactFixture(candidates[0]),
    };
  }
}

function responseRows(result) {
  return Array.isArray(result?.data?.response) ? result.data.response : [];
}

function sameProviderId(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return String(left) === String(right);
}

function coachCoversDate(coach, teamId, fixtureDate) {
  return (coach?.career || []).some(assignment => {
    if (!sameProviderId(assignment?.team?.id, teamId)) return false;
    const start = String(assignment?.start || '');
    const end = String(assignment?.end || '');
    return (!start || start <= fixtureDate) && (!end || fixtureDate <= end);
  });
}

function selectCoachForDate(rows, teamId, fixtureDate) {
  const candidates = (rows || []).filter(coach => coachCoversDate(coach, teamId, fixtureDate));
  return candidates.length === 1 ? candidates[0] : null;
}

function matchNeedsCoachEnrichment(fragment, matchId) {
  const update = (fragment?.matchUpdates || []).find(row => row.matchId === matchId);
  return (update?.formationData?.teams || []).some(team =>
    team.lineupAvailable && (!team.coach || !team.coach.photo)
  );
}

async function enrichMissingLineupCoaches(lineups, target, client, budget, state, cache, updated) {
  const enriched = (lineups || []).map(lineup => ({ ...lineup }));
  const supplementalEndpoints = [];
  state.coachResolutions = state.coachResolutions || {};

  for (const lineup of enriched) {
    const existingCoach = lineup?.coach;
    if (existingCoach && (
      existingCoach.id !== null && existingCoach.id !== undefined ||
      existingCoach.name ||
      existingCoach.photo
    )) continue;
    const teamId = lineup?.team?.id;
    if (teamId === null || teamId === undefined) continue;
    const cacheKey = String(teamId);
    if (!cache.has(cacheKey)) {
      if (!budget.hasCapacity(1)) {
        budget.stoppedReason = 'daily_quota_reserve';
        throw new QuotaStop('API-Football request reserve reached during coach enrichment.');
      }
      const result = await budget.get(client, '/coachs', { team: teamId });
      cache.set(cacheKey, responseRows(result));
    }

    const endpoint = `/coachs?team=${teamId}`;
    if (!supplementalEndpoints.includes(endpoint)) supplementalEndpoints.push(endpoint);
    const rows = cache.get(cacheKey);
    const selected = selectCoachForDate(rows, teamId, target.fixtureDate);
    const resolutionKey = `${teamId}|${target.fixtureDate}`;
    if (!selected) {
      const candidateCount = rows.filter(coach => coachCoversDate(coach, teamId, target.fixtureDate)).length;
      state.coachResolutions[resolutionKey] = {
        providerTeamId: teamId,
        fixtureDate: target.fixtureDate,
        candidateCount,
        reason: candidateCount ? 'ambiguous_coach_assignment' : 'coach_assignment_not_found',
        resolvedAt: updated,
      };
      continue;
    }
    lineup.coach = {
      id: selected.id ?? null,
      name: selected.name || [selected.firstname, selected.lastname].filter(Boolean).join(' ') || null,
      photo: selected.photo || null,
      photoSource: 'api_football_coach_registry',
    };
    state.coachResolutions[resolutionKey] = {
      providerTeamId: teamId,
      providerCoachId: selected.id ?? null,
      providerCoachName: lineup.coach.name,
      fixtureDate: target.fixtureDate,
      method: 'team_career_date_exact',
      resolvedAt: updated,
    };
  }
  return { lineups: enriched, supplementalEndpoints };
}

function localNameMaps(target, baseFixture) {
  return {
    clubNamesByProviderId: {
      [String(baseFixture?.teams?.home?.id)]: target.score.homeName,
      [String(baseFixture?.teams?.away?.id)]: target.score.awayName,
    },
    competitionNamesByProviderId: {
      [String(baseFixture?.league?.id)]: target.league,
    },
  };
}

function normalizeMappedFragment(mapped, target, fixtureId, updated, discovery, supplementalEndpoints = []) {
  const matchUpdate = mapped.matchUpdates?.[0];
  if (matchUpdate) {
    Object.assign(matchUpdate, {
      matchId: target.matchId,
      league: target.league,
      round: target.round,
      ko: target.ko,
      match: target.match,
      status: 'verified',
      addIfMissing: false,
    });
  }
  for (const record of mapped.playerMatchStats || []) {
    Object.assign(record, {
      matchId: target.matchId,
      competition: target.league,
      league: target.league,
      match: target.match,
      ko: target.ko,
      round: target.round,
    });
  }
  for (const row of mapped.gaResultsAdd || []) {
    Object.assign(row, {
      matchId: target.matchId,
      league: target.league,
      match: target.match,
      ko: target.ko,
      round: target.round,
    });
  }
  const sourceId = `api-football-fixture-${fixtureId}`;
  if (mapped.sources?.[sourceId]) {
    const discoveryEndpoint = discovery?.mode === 'manifest_fixture_id'
        ? `/fixtures?id=${fixtureId}`
        : `/fixtures?date=${target.fixtureDate}`;
    mapped.sources[sourceId] = {
      ...mapped.sources[sourceId],
      name: 'API-Football existing-result fixture bundle',
      endpoint: `/fixtures/${fixtureId}/existing-result-enrichment`,
      endpoints: [
        discoveryEndpoint,
        `/fixtures/events?fixture=${fixtureId}`,
        `/fixtures/lineups?fixture=${fixtureId}`,
        `/fixtures/players?fixture=${fixtureId}`,
        ...supplementalEndpoints,
      ],
      retrievedAt: updated,
    };
  }
  return mapped;
}

function ensureFragmentInIndex(index, fragmentName) {
  index.fragments = index.fragments || [];
  if (!index.fragments.includes(fragmentName)) index.fragments.push(fragmentName);
  return index;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

async function runBackfill(options = {}) {
  const root = options.root || ROOT;
  const manifestPath = options.manifestPath || path.join(root, 'config', 'api-football-existing-results.json');
  const providerConfigPath = options.providerConfigPath || path.join(root, 'config', 'api-football.json');
  const manifest = readJson(manifestPath);
  const providerConfig = readJson(providerConfigPath);
  const data = mergeCurrentData(root, manifest.season);
  const targets = buildTargets(data, manifest);
  const backfillDirectory = path.join(root, 'data', manifest.season, 'backfill');
  const indexPath = path.join(backfillDirectory, 'index.json');
  const fragmentPath = path.join(backfillDirectory, GENERATED_FRAGMENT);
  const statePath = path.join(root, 'state', 'api-football-existing-results.json');
  const state = readJsonIfExists(statePath, emptyState(manifest));
  let fragment = readJsonIfExists(fragmentPath, emptyFragment(manifest));
  const updated = options.updated || new Date().toISOString();
  const client = options.client || createClientFromEnv();
  const budget = options.budget || new RequestBudget(providerConfig, {
    maxRequests: options.maxRequests ?? process.env.API_FOOTBALL_MAX_REQUESTS,
    minimumIntervalMs: options.minimumIntervalMs ?? process.env.API_FOOTBALL_MIN_INTERVAL_MS,
  });
  const completed = new Set(state.completedMatchIds || []);
  for (const target of targets) {
    if (matchNeedsCoachEnrichment(fragment, target.matchId)) completed.delete(target.matchId);
  }
  const unresolvedPlayers = { ...(state.lastRun?.unresolvedPlayers || {}) };
  const coachCache = new Map();
  let runError = null;

  async function processResolvedTargets() {
    for (const target of targets) {
      if (completed.has(target.matchId)) continue;
      const resolution = state.fixtureResolutions?.[target.matchId];
      if (!resolutionStillValid(resolution, target)) continue;
      if (!budget.hasCapacity(3)) {
        budget.stoppedReason = 'daily_quota_reserve';
        break;
      }

      const fixtureId = resolution.fixtureId;
      const eventsResult = await budget.get(client, '/fixtures/events', { fixture: fixtureId });
      const lineupsResult = await budget.get(client, '/fixtures/lineups', { fixture: fixtureId });
      const playersResult = await budget.get(client, '/fixtures/players', { fixture: fixtureId });
      const coachEnrichment = await enrichMissingLineupCoaches(
        responseRows(lineupsResult),
        target,
        client,
        budget,
        state,
        coachCache,
        updated
      );
      const fixture = {
        ...resolution.baseFixture,
        events: responseRows(eventsResult),
        lineups: coachEnrichment.lineups,
        players: responseRows(playersResult),
      };
      if (!fixtureMatchesTarget(fixture, target)) {
        throw new Error(`Resolved API-Football fixture no longer matches stored result: ${target.matchId}`);
      }

      const playerResolution = resolvedTrackedPlayers(data, target, fixture, manifest, state, updated);
      delete unresolvedPlayers[target.matchId];
      if (playerResolution.unresolved.length) unresolvedPlayers[target.matchId] = playerResolution.unresolved;
      const names = localNameMaps(target, resolution.baseFixture);
      const mapped = mapFixtureToSchemaV2(fixture, {
        season: manifest.season,
        updated,
        matchId: target.matchId,
        trackedPlayers: playerResolution.tracked,
        ...names,
      });
      fragment = mergeFragment(fragment, normalizeMappedFragment(
        mapped,
        target,
        fixtureId,
        updated,
        resolution.discovery,
        coachEnrichment.supplementalEndpoints
      ));
      completed.add(target.matchId);
    }
  }

  try {
    await resolveManifestFixtureIds(targets, client, budget, state, manifest, updated);
    await processResolvedTargets();
    if (manifest.providerPlanConstraints?.historicalFixtureIdDiscoveryEnabled !== false) {
      await resolveFixtures(targets, client, budget, state, manifest, updated);
      await processResolvedTargets();
    } else {
      for (const target of targets) {
        if (completed.has(target.matchId) || resolutionStillValid(state.fixtureResolutions?.[target.matchId], target)) continue;
        state.fixtureResolutions[target.matchId] = {
          ...(state.fixtureResolutions?.[target.matchId] || {}),
          fixtureId: null,
          signature: selectionSignature(target),
          reason: 'historical_fixture_id_discovery_disabled',
          resolvedAt: updated,
        };
      }
    }
  } catch (error) {
    if (!(error instanceof QuotaStop)) runError = error;
    else budget.stoppedReason = budget.stoppedReason || 'daily_quota_reserve';
  } finally {
    const resolved = targets.filter(target => resolutionStillValid(state.fixtureResolutions?.[target.matchId], target));
    state.security = {
      ...(state.security || {}),
      apiKeyPersisted: false,
      rawResponsesPersisted: false,
      scheduledFixturesRequested: false,
      unlistedFixturesPersisted: false,
      fixedManifestDateDiscoveryUsed: manifest.providerPlanConstraints?.historicalFixtureIdDiscoveryEnabled !== false,
      teamLastDiscoveryUsed: false,
    };
    state.targetCount = targets.length;
    state.completedMatchIds = sortedUnique([...completed]);
    state.unresolvedMatchIds = sortedUnique(targets
      .filter(target => state.fixtureResolutions?.[target.matchId]?.reason)
      .map(target => target.matchId));
    state.pendingMatchIds = sortedUnique(targets
      .filter(target => !completed.has(target.matchId) && !state.unresolvedMatchIds.includes(target.matchId))
      .map(target => target.matchId));
    state.lastRun = {
      startedFromFixedManifest: true,
      completedAt: updated,
      requestCount: budget.requestCount,
      dailyRemaining: budget.dailyRemaining,
      minuteRemaining: budget.minuteRemaining,
      reserve: budget.reserve,
      stoppedReason: budget.stoppedReason,
      resolvedFixtureCount: resolved.length,
      completedFixtureCount: completed.size,
      unresolvedPlayers,
      error: runError ? runError.message : null,
      errorDetails: runError ? safeApiErrorDetails(runError) : null,
    };
    fragment.updated = updated;
    const index = ensureFragmentInIndex(readJson(indexPath), GENERATED_FRAGMENT);
    index.updated = updated;
    writeJson(fragmentPath, fragment);
    writeJson(statePath, state);
    writeJson(indexPath, index);
  }

  const summary = {
    provider: 'api-football',
    mode: 'existing_verified_results_only',
    targetMatches: targets.length,
    completedMatches: state.completedMatchIds.length,
    pendingMatches: state.pendingMatchIds.length,
    unresolvedMatches: state.unresolvedMatchIds.length,
    requestsThisRun: budget.requestCount,
    dailyRemaining: budget.dailyRemaining,
    quotaReserve: budget.reserve,
    stoppedReason: budget.stoppedReason,
    rawResponsesPersisted: false,
    scheduledFixturesRequested: false,
    unlistedFixturesPersisted: false,
    fixedManifestDateDiscoveryUsed: manifest.providerPlanConstraints?.historicalFixtureIdDiscoveryEnabled !== false,
    teamLastDiscoveryUsed: false,
  };
  if (runError) throw Object.assign(runError, { summary });
  return summary;
}

async function main() {
  try {
    const summary = await runBackfill();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(`API-Football existing-results backfill: FAILED - ${error.message}`);
    if (error.summary) console.error(JSON.stringify(error.summary, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  GENERATED_FRAGMENT,
  QuotaStop,
  RequestBudget,
  safeApiErrorDetails,
  aliasMatches,
  buildTargets,
  compactFixture,
  eligibleMatches,
  fixtureMatchesTarget,
  mergeCurrentData,
  mergeFragment,
  matchNeedsCoachEnrichment,
  enrichMissingLineupCoaches,
  normalizeProviderName,
  parseStoredScore,
  resolvedTrackedPlayers,
  runBackfill,
  selectCoachForDate,
  stablePlayerId,
};
