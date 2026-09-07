'use strict';

const CONTRACT_VERSION = '2.1.0';
const PROVIDER = 'api-football';
const PRODUCT_TIME_ZONE = 'Asia/Tokyo';
const FINAL_STATUSES = new Set(['FT', 'AET', 'PEN']);
const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT']);
const REVIEW_STATUSES = new Set(['CANC', 'ABD', 'AWD', 'WO']);

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

function afId(kind, providerId) {
  if (providerId === null || providerId === undefined || providerId === '') return null;
  return `af:${kind}:${String(providerId)}`;
}

function seasonId(competitionProviderId, season) {
  if (competitionProviderId === null || competitionProviderId === undefined || season === null || season === undefined) return null;
  return `af:season:${String(competitionProviderId)}:${String(season)}`;
}

function toUtcIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function jstDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PRODUCT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function sectionPresence(record, key) {
  return Object.prototype.hasOwnProperty.call(record || {}, key) ? 'present' : 'not_fetched';
}

function ingestionState(statusShort, finalized = false) {
  const status = String(statusShort || '').toUpperCase();
  if (REVIEW_STATUSES.has(status)) return 'needs_review';
  if (FINAL_STATUSES.has(status)) return finalized ? 'finalized' : 'provisional_final';
  if (LIVE_STATUSES.has(status)) return 'live';
  return 'scheduled';
}

function recordProvenance(fetchedAt, issues = []) {
  return {
    source: PROVIDER,
    fetchedAt,
    verification: 'provider',
    issues: [...issues],
  };
}

function normalizeTeam(team) {
  if (!team) return null;
  const providerId = numeric(team.id) ?? team.id ?? null;
  return {
    id: afId('team', providerId),
    providerId,
    name: text(team.name),
    logo: text(team.logo),
    winner: typeof team.winner === 'boolean' ? team.winner : null,
  };
}

function normalizeCoach(coach) {
  if (!coach) return null;
  const providerId = numeric(coach.id) ?? coach.id ?? null;
  if (providerId === null && !text(coach.name)) return null;
  return {
    id: afId('coach', providerId),
    providerId,
    name: text(coach.name),
    photo: text(coach.photo),
  };
}

function normalizeLineupPlayer(item, role) {
  const player = item?.player || item || {};
  const providerId = numeric(player.id) ?? player.id ?? null;
  if (providerId === null && !text(player.name)) return null;
  return {
    id: afId('player', providerId),
    providerId,
    name: text(player.name),
    number: numeric(player.number),
    position: text(player.pos)?.toUpperCase() || null,
    grid: text(player.grid),
    role,
  };
}

function normalizeLineups(fixture, fetchedAt) {
  return (fixture.lineups || []).map(lineup => {
    const teamProviderId = numeric(lineup?.team?.id) ?? lineup?.team?.id ?? null;
    const formation = text(lineup?.formation);
    return {
      teamId: afId('team', teamProviderId),
      formation,
      fieldStates: formation ? {} : { formation: { presence: 'provider_missing' } },
      coach: normalizeCoach(lineup?.coach),
      startXI: (lineup?.startXI || []).map(item => normalizeLineupPlayer(item, 'starter')).filter(Boolean),
      substitutes: (lineup?.substitutes || []).map(item => normalizeLineupPlayer(item, 'substitute')).filter(Boolean),
      provenance: recordProvenance(fetchedAt),
    };
  });
}

function canonicalEventType(type) {
  const value = String(type || '').toLowerCase();
  if (value === 'goal') return 'goal';
  if (value === 'card') return 'card';
  if (value === 'subst' || value === 'substitution') return 'substitution';
  if (value === 'var') return 'var';
  return value || 'other';
}

function normalizeEvents(fixture, fixtureProviderId, fetchedAt) {
  return (fixture.events || []).map((event, index) => ({
    id: `af:event:${fixtureProviderId}:${index}`,
    type: canonicalEventType(event?.type),
    detail: text(event?.detail),
    comments: text(event?.comments),
    elapsed: numeric(event?.time?.elapsed),
    extra: numeric(event?.time?.extra),
    teamId: afId('team', numeric(event?.team?.id) ?? event?.team?.id ?? null),
    playerId: afId('player', numeric(event?.player?.id) ?? event?.player?.id ?? null),
    relatedPlayerId: afId('player', numeric(event?.assist?.id) ?? event?.assist?.id ?? null),
    provenance: recordProvenance(fetchedAt),
  }));
}

function assignNumeric(values, key, value) {
  const parsed = numeric(value);
  if (parsed !== null) values[key] = parsed;
}

function normalizePlayerStats(fixture, fetchedAt) {
  const rows = [];
  for (const teamBlock of fixture.players || []) {
    const teamProviderId = numeric(teamBlock?.team?.id) ?? teamBlock?.team?.id ?? null;
    for (const item of teamBlock?.players || []) {
      const player = item?.player || {};
      const playerProviderId = numeric(player.id) ?? player.id ?? null;
      const stats = Array.isArray(item?.statistics) ? (item.statistics[0] || {}) : {};
      const values = {};
      assignNumeric(values, 'minutes', stats?.games?.minutes);
      assignNumeric(values, 'rating', stats?.games?.rating);
      assignNumeric(values, 'goals', stats?.goals?.total);
      assignNumeric(values, 'assists', stats?.goals?.assists);
      assignNumeric(values, 'goalsConceded', stats?.goals?.conceded);
      assignNumeric(values, 'saves', stats?.goals?.saves);
      assignNumeric(values, 'shots', stats?.shots?.total);
      assignNumeric(values, 'shotsOnTarget', stats?.shots?.on);
      assignNumeric(values, 'passes', stats?.passes?.total);
      assignNumeric(values, 'keyPasses', stats?.passes?.key);
      assignNumeric(values, 'passAccuracy', stats?.passes?.accuracy);
      assignNumeric(values, 'tackles', stats?.tackles?.total);
      assignNumeric(values, 'blocks', stats?.tackles?.blocks);
      assignNumeric(values, 'interceptions', stats?.tackles?.interceptions);
      assignNumeric(values, 'duels', stats?.duels?.total);
      assignNumeric(values, 'duelsWon', stats?.duels?.won);
      assignNumeric(values, 'dribbleAttempts', stats?.dribbles?.attempts);
      assignNumeric(values, 'dribbles', stats?.dribbles?.success);
      assignNumeric(values, 'dribbledPast', stats?.dribbles?.past);
      assignNumeric(values, 'foulsDrawn', stats?.fouls?.drawn);
      assignNumeric(values, 'foulsCommitted', stats?.fouls?.committed);
      assignNumeric(values, 'yellowCards', stats?.cards?.yellow);
      assignNumeric(values, 'redCards', stats?.cards?.red);
      assignNumeric(values, 'penaltiesWon', stats?.penalty?.won);
      assignNumeric(values, 'penaltiesConceded', stats?.penalty?.commited);
      assignNumeric(values, 'penaltiesScored', stats?.penalty?.scored);
      assignNumeric(values, 'penaltiesMissed', stats?.penalty?.missed);
      assignNumeric(values, 'penaltiesSaved', stats?.penalty?.saved);

      const position = text(stats?.games?.position)?.toUpperCase() || text(player?.position)?.toUpperCase() || null;
      const fieldStates = {};
      if (position && position !== 'G' && position !== 'GK' && !Object.prototype.hasOwnProperty.call(values, 'saves')) {
        fieldStates.saves = { presence: 'not_applicable' };
        fieldStates.penaltiesSaved = { presence: 'not_applicable' };
      }

      rows.push({
        fixtureId: afId('fixture', fixture?.fixture?.id),
        playerId: afId('player', playerProviderId),
        playerProviderId,
        playerName: text(player.name),
        playerPhoto: text(player.photo),
        teamId: afId('team', teamProviderId),
        position,
        starter: typeof stats?.games?.substitute === 'boolean' ? !stats.games.substitute : null,
        captain: typeof stats?.games?.captain === 'boolean' ? stats.games.captain : null,
        values,
        fieldStates,
        fieldIssues: {},
        provenance: recordProvenance(fetchedAt),
      });
    }
  }
  return rows;
}

function statKey(type) {
  return String(type || '')
    .trim()
    .toLowerCase()
    .replace(/%/g, ' percent ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function statValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+(?:\.\d+)?%$/.test(trimmed)) return Number(trimmed.slice(0, -1));
    const parsed = numeric(trimmed);
    if (parsed !== null) return parsed;
    return trimmed || null;
  }
  return value ?? null;
}

function normalizeTeamStats(fixture, fetchedAt) {
  return (fixture.statistics || []).map(block => ({
    teamId: afId('team', numeric(block?.team?.id) ?? block?.team?.id ?? null),
    values: Object.fromEntries((block?.statistics || []).map(row => [statKey(row?.type), statValue(row?.value)])),
    provenance: recordProvenance(fetchedAt),
  }));
}

function normalizeFixtureBundle(fixture, options = {}) {
  const fixtureProviderId = fixture?.fixture?.id;
  if (fixtureProviderId === null || fixtureProviderId === undefined) {
    throw new Error('API-Football fixture.id is required.');
  }
  const fetchedAt = toUtcIso(options.fetchedAt || new Date()) || new Date().toISOString();
  const competitionProviderId = numeric(fixture?.league?.id) ?? fixture?.league?.id ?? null;
  const competitionSeason = numeric(fixture?.league?.season) ?? fixture?.league?.season ?? null;
  const kickoffUtc = toUtcIso(fixture?.fixture?.date);
  const statusShort = text(fixture?.fixture?.status?.short)?.toUpperCase() || null;
  const competition = {
    id: afId('competition', competitionProviderId),
    providerId: competitionProviderId,
    name: text(fixture?.league?.name),
    country: text(fixture?.league?.country),
    logo: text(fixture?.league?.logo),
    flag: text(fixture?.league?.flag),
  };
  const season = {
    id: seasonId(competitionProviderId, competitionSeason),
    competitionId: competition.id,
    providerSeason: competitionSeason,
    label: competitionSeason === null ? null : String(competitionSeason),
  };
  const home = normalizeTeam(fixture?.teams?.home);
  const away = normalizeTeam(fixture?.teams?.away);

  const bundle = {
    contractVersion: CONTRACT_VERSION,
    detailAvailability: 'available',
    fixture: {
      id: afId('fixture', fixtureProviderId),
      providerId: numeric(fixtureProviderId) ?? fixtureProviderId,
      competitionId: competition.id,
      seasonId: season.id,
      kickoffUtc,
      dateJst: kickoffUtc ? jstDateKey(kickoffUtc) : null,
      productTimeZone: PRODUCT_TIME_ZONE,
      round: text(fixture?.league?.round),
      referee: text(fixture?.fixture?.referee),
      venue: {
        id: afId('venue', numeric(fixture?.fixture?.venue?.id) ?? fixture?.fixture?.venue?.id ?? null),
        providerId: numeric(fixture?.fixture?.venue?.id) ?? fixture?.fixture?.venue?.id ?? null,
        name: text(fixture?.fixture?.venue?.name),
        city: text(fixture?.fixture?.venue?.city),
      },
      status: {
        short: statusShort,
        long: text(fixture?.fixture?.status?.long),
        elapsed: numeric(fixture?.fixture?.status?.elapsed),
      },
      ingestionState: ingestionState(statusShort, options.finalized === true),
      teams: { home, away },
      score: {
        goals: { home: numeric(fixture?.goals?.home), away: numeric(fixture?.goals?.away) },
        halftime: { home: numeric(fixture?.score?.halftime?.home), away: numeric(fixture?.score?.halftime?.away) },
        fulltime: { home: numeric(fixture?.score?.fulltime?.home), away: numeric(fixture?.score?.fulltime?.away) },
        extratime: { home: numeric(fixture?.score?.extratime?.home), away: numeric(fixture?.score?.extratime?.away) },
        penalty: { home: numeric(fixture?.score?.penalty?.home), away: numeric(fixture?.score?.penalty?.away) },
      },
      revision: numeric(options.revision) || 1,
      reconciledAt: fetchedAt,
      provenance: recordProvenance(fetchedAt),
    },
    competition,
    season,
    lineups: normalizeLineups(fixture, fetchedAt),
    events: normalizeEvents(fixture, fixtureProviderId, fetchedAt),
    teamStats: normalizeTeamStats(fixture, fetchedAt),
    playerStats: normalizePlayerStats(fixture, fetchedAt),
    sectionStates: {
      events: { presence: sectionPresence(fixture, 'events') },
      lineups: { presence: sectionPresence(fixture, 'lineups') },
      teamStats: { presence: sectionPresence(fixture, 'statistics') },
      playerStats: { presence: sectionPresence(fixture, 'players') },
    },
    overrides: {},
    fieldIssues: {},
  };

  return bundle;
}

function splitPath(path) {
  return String(path || '').split('.').filter(Boolean);
}

function getPath(object, path) {
  let current = object;
  for (const part of splitPath(path)) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function setPath(object, path, value) {
  const parts = splitPath(path);
  if (!parts.length) throw new Error('Correction path is required.');
  let current = object;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyManualCorrections(bundle, corrections = []) {
  const next = structuredClone(bundle);
  next.overrides ||= {};
  next.fieldIssues ||= {};

  for (const correction of corrections) {
    const path = text(correction?.path);
    if (!path) continue;
    const currentProviderValue = getPath(next, path);
    const correctedProviderValue = correction?.correctedProviderValue;
    const correctionValue = correction?.value;
    const base = {
      value: correctionValue,
      correctedProviderValue,
      reason: text(correction?.reason),
      sourceUrl: text(correction?.sourceUrl),
      verifiedAt: toUtcIso(correction?.verifiedAt),
    };

    if (sameValue(currentProviderValue, correctedProviderValue)) {
      setPath(next, path, correctionValue);
      next.overrides[path] = { ...base, status: 'active' };
      continue;
    }

    if (sameValue(currentProviderValue, correctionValue)) {
      next.overrides[path] = { ...base, status: 'provider_caught_up' };
      continue;
    }

    next.overrides[path] = { ...base, status: 'review_required', providerValue: currentProviderValue };
    next.fieldIssues[path] = [...new Set([...(next.fieldIssues[path] || []), 'conflict'])];
    next.fixture.ingestionState = 'needs_review';
  }

  return next;
}

function r2FixtureKey(bundle) {
  const competitionId = bundle?.fixture?.competitionId;
  const season = bundle?.fixture?.seasonId;
  const fixtureId = bundle?.fixture?.id;
  if (!competitionId || !season || !fixtureId) throw new Error('Fixture, competition and season IDs are required for R2 key generation.');
  return `football/v2/competitions/${competitionId}/seasons/${season}/fixtures/${fixtureId}.json`;
}

function r2FixturePointerKey(fixtureId) {
  if (!fixtureId) throw new Error('Fixture ID is required.');
  return `football/v2/indexes/fixture/${fixtureId}.json`;
}

function r2DateIndexKey(dateJst) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateJst || ''))) throw new Error('JST date must use YYYY-MM-DD.');
  return `football/v2/indexes/date-jst/${dateJst}.json`;
}

function fixtureIndexEntry(bundle) {
  const fixture = bundle.fixture;
  return {
    fixtureId: fixture.id,
    competitionId: fixture.competitionId,
    seasonId: fixture.seasonId,
    kickoffUtc: fixture.kickoffUtc,
    dateJst: fixture.dateJst,
    status: fixture.status,
    ingestionState: fixture.ingestionState,
    teams: fixture.teams,
    score: fixture.score,
  };
}

function validateFixtureBundle(bundle) {
  const errors = [];
  if (bundle?.contractVersion !== CONTRACT_VERSION) errors.push(`contractVersion must be ${CONTRACT_VERSION}`);
  if (bundle?.detailAvailability !== 'available' && bundle?.detailAvailability !== 'unavailable') {
    errors.push('detailAvailability must be available or unavailable');
  }
  if (!bundle?.fixture?.id?.startsWith('af:fixture:')) errors.push('fixture.id must be an API-Football fixture ID.');
  if (!bundle?.fixture?.competitionId?.startsWith('af:competition:')) errors.push('fixture.competitionId is required.');
  if (!bundle?.fixture?.seasonId?.startsWith('af:season:')) errors.push('fixture.seasonId is required.');
  if (!bundle?.fixture?.kickoffUtc?.endsWith('Z')) errors.push('fixture.kickoffUtc must be UTC ISO-8601.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(bundle?.fixture?.dateJst || ''))) errors.push('fixture.dateJst must be a JST YYYY-MM-DD index date.');
  if (!bundle?.fixture?.teams?.home?.id || !bundle?.fixture?.teams?.away?.id) errors.push('Both team IDs are required.');
  return errors;
}

module.exports = {
  CONTRACT_VERSION,
  FINAL_STATUSES,
  LIVE_STATUSES,
  PRODUCT_TIME_ZONE,
  PROVIDER,
  afId,
  applyManualCorrections,
  fixtureIndexEntry,
  getPath,
  ingestionState,
  jstDateKey,
  normalizeFixtureBundle,
  r2DateIndexKey,
  r2FixtureKey,
  r2FixturePointerKey,
  seasonId,
  setPath,
  validateFixtureBundle,
};
