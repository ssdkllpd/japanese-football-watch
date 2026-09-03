import {
  assertValidDateIndexPayload,
  fixtureIdDigestInput,
} from '../shared/date-index-contract.mjs';
import {
  assertValidStandingsPayload,
  standingsIdentityDigestInput,
} from '../shared/standings-contract.mjs';
import { FIXTURE_DETAIL_SCHEMA } from '../shared/fixture-detail-contract.mjs';
import fixtureRepositoryModule from '../scripts/d1/fixture-repository.js';

const { FixtureRepository } = fixtureRepositoryModule;

const API_BASE = 'https://v3.football.api-sports.io';
const LIVE_TTL_SECONDS = 60;
const DATE_TTL_SECONDS = 300;
const STANDINGS_TTL_SECONDS = 300;
const FIXTURE_DETAIL_TTL_SECONDS = 300;
const DEGRADED_TTL_SECONDS = 60;
const memoryRate = new Map();

const FIXTURE_INDEX_COLUMNS_SQL = `
  fixture.canonical_id AS fixture_id,
  fixture.kickoff_utc,
  fixture.date_jst,
  fixture.status_short,
  fixture.status_long,
  fixture.status_elapsed,
  fixture.ingestion_state,
  fixture.home_goals,
  fixture.away_goals,
  fixture.home_winner,
  fixture.away_winner,
  competition.canonical_id AS competition_id,
  competition.provider_id AS competition_provider_id,
  competition.name AS competition_name,
  competition.country_name AS competition_country,
  competition.logo_url AS competition_logo,
  competition.flag_url AS competition_flag,
  season.canonical_id AS season_id,
  home.canonical_id AS home_team_id,
  home.provider_id AS home_team_provider_id,
  home.name AS home_team_name,
  home.logo_url AS home_team_logo,
  away.canonical_id AS away_team_id,
  away.provider_id AS away_team_provider_id,
  away.name AS away_team_name,
  away.logo_url AS away_team_logo,
  (SELECT home_value FROM fixture_score_parts
    WHERE fixture_id = fixture.id AND score_kind = 'halftime') AS halftime_home,
  (SELECT away_value FROM fixture_score_parts
    WHERE fixture_id = fixture.id AND score_kind = 'halftime') AS halftime_away,
  (SELECT home_value FROM fixture_score_parts
    WHERE fixture_id = fixture.id AND score_kind = 'fulltime') AS fulltime_home,
  (SELECT away_value FROM fixture_score_parts
    WHERE fixture_id = fixture.id AND score_kind = 'fulltime') AS fulltime_away,
  (SELECT home_value FROM fixture_score_parts
    WHERE fixture_id = fixture.id AND score_kind = 'extratime') AS extratime_home,
  (SELECT away_value FROM fixture_score_parts
    WHERE fixture_id = fixture.id AND score_kind = 'extratime') AS extratime_away,
  (SELECT home_value FROM fixture_score_parts
    WHERE fixture_id = fixture.id AND score_kind = 'penalty') AS penalty_home,
  (SELECT away_value FROM fixture_score_parts
    WHERE fixture_id = fixture.id AND score_kind = 'penalty') AS penalty_away
`;

const FIXTURE_INDEX_JOINS_SQL = `
LEFT JOIN competition_seasons season ON season.id = fixture.competition_season_id
LEFT JOIN competitions competition ON competition.id = season.competition_id
LEFT JOIN teams home ON home.id = fixture.home_team_id
LEFT JOIN teams away ON away.id = fixture.away_team_id`;

const DATE_FIXTURES_SQL = `
WITH coverage AS (
  SELECT date_jst, fixture_count, fixture_id_digest, generated_at
  FROM date_index_coverages
  WHERE date_jst = ?1
)
SELECT
  coverage.fixture_count AS coverage_fixture_count,
  coverage.fixture_id_digest AS coverage_fixture_id_digest,
  coverage.generated_at AS coverage_generated_at,
  ${FIXTURE_INDEX_COLUMNS_SQL}
FROM coverage
LEFT JOIN fixtures fixture ON fixture.date_jst = coverage.date_jst
${FIXTURE_INDEX_JOINS_SQL}
ORDER BY fixture.kickoff_utc, fixture.canonical_id`;

const COMPETITION_DATE_FIXTURES_SQL = `
WITH coverage AS (
  SELECT item.date_jst, item.fixture_count, item.fixture_id_digest,
    item.generated_at, item.competition_id
  FROM competition_date_index_coverages item
  JOIN competitions scoped_competition ON scoped_competition.id = item.competition_id
  WHERE scoped_competition.canonical_id = ?1 AND item.date_jst = ?2
)
SELECT
  coverage.fixture_count AS coverage_fixture_count,
  coverage.fixture_id_digest AS coverage_fixture_id_digest,
  coverage.generated_at AS coverage_generated_at,
  ${FIXTURE_INDEX_COLUMNS_SQL}
FROM coverage
LEFT JOIN competition_seasons scoped_season
  ON scoped_season.competition_id = coverage.competition_id
LEFT JOIN fixtures fixture
  ON fixture.competition_season_id = scoped_season.id
  AND fixture.date_jst = coverage.date_jst
${FIXTURE_INDEX_JOINS_SQL}
ORDER BY fixture.kickoff_utc, fixture.canonical_id`;

const COMPETITION_SQL = `
SELECT canonical_id, provider_id, name, country_name, logo_url, flag_url
FROM competitions
WHERE canonical_id = ?1
LIMIT 1`;

const STANDINGS_IDENTITY_SQL = `
SELECT
  competition.canonical_id AS competition_id,
  competition.provider_id AS competition_provider_id,
  competition.name AS competition_name,
  competition.country_name AS competition_country,
  competition.logo_url AS competition_logo,
  competition.flag_url AS competition_flag,
  season.id AS season_row_id,
  season.canonical_id AS season_id,
  season.provider_season,
  season.label AS season_label
FROM competitions competition
LEFT JOIN competition_seasons season
  ON season.competition_id = competition.id AND season.canonical_id = ?2
WHERE competition.canonical_id = ?1
LIMIT 1`;

const STANDINGS_ROWS_SQL = `
WITH publication AS (
  SELECT publication.snapshot_id, publication.row_count,
    publication.identity_digest, publication.generated_at,
    publication.competition_season_id
  FROM standings_publications publication
  JOIN competition_seasons season
    ON season.id = publication.competition_season_id
  JOIN competitions competition ON competition.id = season.competition_id
  WHERE competition.canonical_id = ?1 AND season.canonical_id = ?2
)
SELECT
  publication.row_count AS publication_row_count,
  publication.identity_digest AS publication_identity_digest,
  publication.generated_at AS publication_generated_at,
  snapshot.contract_version,
  snapshot.section_presence,
  snapshot.provenance_source AS snapshot_provenance_source,
  snapshot.provenance_fetched_at AS snapshot_provenance_fetched_at,
  snapshot.provenance_verification AS snapshot_provenance_verification,
  snapshot.provenance_issues_json AS snapshot_provenance_issues_json,
  group_row.group_id,
  group_row.group_name,
  group_row.group_order,
  standing.row_order,
  standing.rank,
  standing.points,
  standing.played AS overall_played,
  standing.wins AS overall_wins,
  standing.draws AS overall_draws,
  standing.losses AS overall_losses,
  standing.goals_for AS overall_goals_for,
  standing.goals_against AS overall_goals_against,
  standing.home_played,
  standing.home_wins,
  standing.home_draws,
  standing.home_losses,
  standing.home_goals_for,
  standing.home_goals_against,
  standing.away_played,
  standing.away_wins,
  standing.away_draws,
  standing.away_losses,
  standing.away_goals_for,
  standing.away_goals_against,
  standing.goal_difference,
  standing.form,
  standing.status,
  standing.description,
  standing.updated_at,
  standing.provenance_source AS row_provenance_source,
  standing.provenance_fetched_at AS row_provenance_fetched_at,
  standing.provenance_verification AS row_provenance_verification,
  standing.provenance_issues_json AS row_provenance_issues_json,
  team.canonical_id AS team_id,
  team.provider_id AS team_provider_id,
  team.name AS team_name,
  team.logo_url AS team_logo
FROM publication
JOIN standings_snapshots snapshot
  ON snapshot.id = publication.snapshot_id
  AND snapshot.competition_season_id = publication.competition_season_id
LEFT JOIN standings_groups group_row ON group_row.snapshot_id = snapshot.id
LEFT JOIN standings_rows standing
  ON standing.snapshot_id = group_row.snapshot_id
  AND standing.group_id = group_row.group_id
LEFT JOIN teams team ON team.id = standing.team_id
ORDER BY group_row.group_order, standing.row_order`;

function afId(kind, providerId) {
  if (providerId === null || providerId === undefined || providerId === '') return null;
  return `af:${kind}:${String(providerId)}`;
}

function seasonId(competitionProviderId, season) {
  if (competitionProviderId === null || competitionProviderId === undefined || season === null || season === undefined) return null;
  return `af:season:${String(competitionProviderId)}:${String(season)}`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function d1NonNegativeIntegerOrNull(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`D1 ${label} is outside the non-negative integer domain.`);
  }
  return value;
}

function d1IntegerOrNull(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value)) throw new Error(`D1 ${label} is outside the integer domain.`);
  return value;
}

function d1PositiveIntegerOrNull(value, label) {
  const parsed = d1IntegerOrNull(value, label);
  if (parsed !== null && parsed < 1) throw new Error(`D1 ${label} must be positive.`);
  return parsed;
}

function jsonStringArray(value, label) {
  if (typeof value !== 'string') throw new Error(`D1 ${label} is not stored JSON.`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`D1 ${label} is invalid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error(`D1 ${label} is not an array of strings.`);
  }
  return parsed;
}

function booleanOrNull(value) {
  if (value === null || value === undefined) return null;
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new Error('D1 boolean value is outside the supported 0/1 domain.');
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256BytesHex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function enabled(env, name) {
  return String(env[name] || '').trim().toLowerCase() === 'true';
}

function toUtcIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateJst(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function allowedCompetitionIds(env) {
  return new Set(String(env.LIVE_COMPETITION_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean));
}

export function projectLiveFixtures(payload, env = {}) {
  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.response) ? payload.response : []);
  const allowed = allowedCompetitionIds(env);
  const fixtures = rows
    .filter(row => allowed.size === 0 || allowed.has(String(row?.league?.id)))
    .map(row => {
      const fixtureProviderId = row?.fixture?.id;
      const competitionProviderId = row?.league?.id;
      const providerSeason = row?.league?.season;
      const kickoffUtc = toUtcIso(row?.fixture?.date);
      return {
        fixtureId: afId('fixture', fixtureProviderId),
        competitionId: afId('competition', competitionProviderId),
        seasonId: seasonId(competitionProviderId, providerSeason),
        kickoffUtc,
        dateJst: kickoffUtc ? dateJst(kickoffUtc) : null,
        status: {
          short: row?.fixture?.status?.short || null,
          long: row?.fixture?.status?.long || null,
          elapsed: numberOrNull(row?.fixture?.status?.elapsed),
        },
        home: {
          teamId: afId('team', row?.teams?.home?.id),
          name: row?.teams?.home?.name || null,
          logo: row?.teams?.home?.logo || null,
          score: numberOrNull(row?.goals?.home),
        },
        away: {
          teamId: afId('team', row?.teams?.away?.id),
          name: row?.teams?.away?.name || null,
          logo: row?.teams?.away?.logo || null,
          score: numberOrNull(row?.goals?.away),
        },
      };
    });

  return {
    contractVersion: '2.0.0',
    timeZone: 'Asia/Tokyo',
    generatedAt: new Date().toISOString(),
    fixtures,
  };
}

export function isAllowedOrigin(origin, env = {}) {
  if (!origin) return String(env.ALLOW_NO_ORIGIN || '').toLowerCase() === 'true';
  const allowed = String(env.APP_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

export function fixturePointerKey(fixtureId) {
  return `football/v2/indexes/fixture/${fixtureId}.json`;
}

export function dateIndexKey(date) {
  return `football/v2/indexes/date-jst/${date}.json`;
}

export function competitionDateIndexKey(competitionId, date) {
  if (!competitionId) throw new Error('Competition ID is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('JST date must use YYYY-MM-DD.');
  return `football/v2/indexes/competition/${competitionId}/date-jst/${date}.json`;
}

export function standingsLatestKey(competitionId, seasonId) {
  if (!competitionId || !seasonId) throw new Error('Competition and season IDs are required.');
  return `football/v2/competitions/${competitionId}/seasons/${seasonId}/standings/latest.json`;
}

async function d1Rows(env, sql, ...params) {
  if (!env.FOOTBALL_DB || typeof env.FOOTBALL_DB.prepare !== 'function') {
    throw new Error('FOOTBALL_DB D1 binding is not configured.');
  }
  const result = await env.FOOTBALL_DB.prepare(sql).bind(...params).all();
  if (result?.success === false || !Array.isArray(result?.results)) {
    throw new Error('D1 query did not return a successful row set.');
  }
  return result.results;
}

function competitionDto(row) {
  return {
    id: row.canonical_id ?? row.competition_id,
    providerId: d1NonNegativeIntegerOrNull(
      row.provider_id ?? row.competition_provider_id,
      'competition provider ID',
    ),
    name: row.name ?? row.competition_name,
    country: row.country_name ?? row.competition_country ?? null,
    logo: row.logo_url ?? row.competition_logo ?? null,
    flag: row.flag_url ?? row.competition_flag ?? null,
  };
}

function scorePart(row, kind) {
  return {
    home: d1NonNegativeIntegerOrNull(row[`${kind}_home`], `${kind} home score`),
    away: d1NonNegativeIntegerOrNull(row[`${kind}_away`], `${kind} away score`),
  };
}

function fixtureIndexEntryFromD1(row) {
  const competition = competitionDto(row);
  return {
    fixtureId: row.fixture_id,
    competitionId: competition.id,
    seasonId: row.season_id,
    kickoffUtc: row.kickoff_utc,
    dateJst: row.date_jst,
    status: {
      short: row.status_short,
      long: row.status_long ?? null,
      elapsed: d1NonNegativeIntegerOrNull(row.status_elapsed, 'status elapsed'),
    },
    ingestionState: row.ingestion_state,
    teams: {
      home: {
        id: row.home_team_id,
        providerId: d1NonNegativeIntegerOrNull(row.home_team_provider_id, 'home team provider ID'),
        name: row.home_team_name,
        logo: row.home_team_logo ?? null,
        winner: booleanOrNull(row.home_winner),
      },
      away: {
        id: row.away_team_id,
        providerId: d1NonNegativeIntegerOrNull(row.away_team_provider_id, 'away team provider ID'),
        name: row.away_team_name,
        logo: row.away_team_logo ?? null,
        winner: booleanOrNull(row.away_winner),
      },
    },
    score: {
      goals: {
        home: d1NonNegativeIntegerOrNull(row.home_goals, 'home goals'),
        away: d1NonNegativeIntegerOrNull(row.away_goals, 'away goals'),
      },
      halftime: scorePart(row, 'halftime'),
      fulltime: scorePart(row, 'fulltime'),
      extratime: scorePart(row, 'extratime'),
      penalty: scorePart(row, 'penalty'),
    },
    competition,
    competitionName: competition.name,
  };
}

export async function buildD1DateFeed(
  env,
  date,
  competitionId = null,
) {
  let competition = null;
  if (competitionId !== null) {
    const competitionRows = await d1Rows(env, COMPETITION_SQL, competitionId);
    if (competitionRows.length === 0) {
      const error = new Error('D1 competition is not stored.');
      error.code = 'D1_COMPETITION_NOT_FOUND';
      throw error;
    }
    if (competitionRows.length !== 1) throw new Error('D1 competition identity is not unique.');
    competition = competitionDto(competitionRows[0]);
  }
  const fixtureRows = competitionId === null
    ? await d1Rows(env, DATE_FIXTURES_SQL, date)
    : await d1Rows(env, COMPETITION_DATE_FIXTURES_SQL, competitionId, date);
  if (fixtureRows.length === 0) return null;
  const expectedCount = d1NonNegativeIntegerOrNull(
    fixtureRows[0].coverage_fixture_count,
    'date coverage fixture count',
  );
  const generatedAt = fixtureRows[0].coverage_generated_at;
  const expectedDigest = fixtureRows[0].coverage_fixture_id_digest;
  if (!Number.isInteger(expectedCount) || expectedCount < 0) {
    throw new Error('D1 date coverage fixture count is invalid.');
  }
  if (fixtureRows.some(row => row.coverage_fixture_count !== expectedCount
      || row.coverage_fixture_id_digest !== expectedDigest
      || row.coverage_generated_at !== generatedAt)) {
    throw new Error('D1 date coverage metadata is inconsistent.');
  }
  const fixtures = fixtureRows
    .filter(row => row.fixture_id !== null)
    .map(fixtureIndexEntryFromD1);
  if (fixtures.length !== expectedCount || new Set(fixtures.map(fixture => fixture.fixtureId)).size !== expectedCount) {
    throw new Error('D1 date coverage fixture count does not match stored fixtures.');
  }
  const actualDigest = await sha256Hex(fixtureIdDigestInput(fixtures));
  if (actualDigest !== expectedDigest) {
    throw new Error('D1 date coverage fixture identity digest does not match stored fixtures.');
  }
  const result = {
    contractVersion: '2.0.0',
    timeZone: 'Asia/Tokyo',
    date,
  };
  if (competition) result.competition = competition;
  result.fixtures = fixtures;
  result.generatedAt = generatedAt;
  assertValidDateIndexPayload(result, {
    expectedDate: date,
    expectedCompetitionId: competitionId,
  });
  return result;
}

function standingsScope(row, prefix) {
  return {
    played: d1NonNegativeIntegerOrNull(row[`${prefix}_played`], `${prefix} played`),
    wins: d1NonNegativeIntegerOrNull(row[`${prefix}_wins`], `${prefix} wins`),
    draws: d1NonNegativeIntegerOrNull(row[`${prefix}_draws`], `${prefix} draws`),
    losses: d1NonNegativeIntegerOrNull(row[`${prefix}_losses`], `${prefix} losses`),
    goalsFor: d1NonNegativeIntegerOrNull(row[`${prefix}_goals_for`], `${prefix} goals for`),
    goalsAgainst: d1NonNegativeIntegerOrNull(row[`${prefix}_goals_against`], `${prefix} goals against`),
  };
}

function standingsProvenance(row, prefix) {
  return {
    source: row[`${prefix}_provenance_source`],
    fetchedAt: row[`${prefix}_provenance_fetched_at`],
    verification: row[`${prefix}_provenance_verification`],
    issues: jsonStringArray(row[`${prefix}_provenance_issues_json`], `${prefix} provenance issues`),
  };
}

export async function buildD1Standings(env, competitionId, requestedSeasonId) {
  const identityRows = await d1Rows(env, STANDINGS_IDENTITY_SQL, competitionId, requestedSeasonId);
  if (identityRows.length === 0) {
    const error = new Error('D1 competition is not stored.');
    error.code = 'D1_COMPETITION_NOT_FOUND';
    throw error;
  }
  if (identityRows.length !== 1) throw new Error('D1 competition-season identity is not unique.');
  const identity = identityRows[0];
  if (identity.season_row_id === null || identity.season_row_id === undefined) {
    const error = new Error('D1 competition season is not stored.');
    error.code = 'D1_SEASON_NOT_FOUND';
    throw error;
  }
  const rows = await d1Rows(env, STANDINGS_ROWS_SQL, competitionId, requestedSeasonId);
  if (rows.length === 0) return null;
  const expectedCount = d1NonNegativeIntegerOrNull(rows[0].publication_row_count, 'standings row count');
  const expectedDigest = rows[0].publication_identity_digest;
  const generatedAt = rows[0].publication_generated_at;
  if (rows.some(row => row.publication_row_count !== expectedCount
    || row.publication_identity_digest !== expectedDigest
    || row.publication_generated_at !== generatedAt)) {
    throw new Error('D1 standings publication metadata is inconsistent.');
  }
  const groups = [];
  let currentGroup = null;
  let actualCount = 0;
  for (const row of rows) {
    if (row.group_id === null) continue;
    if (!currentGroup || currentGroup.id !== row.group_id) {
      currentGroup = { id: row.group_id, name: row.group_name, table: [] };
      groups.push(currentGroup);
    }
    if (row.team_id === null) continue;
    currentGroup.table.push({
      rank: d1PositiveIntegerOrNull(row.rank, 'standings rank'),
      team: {
        id: row.team_id,
        providerId: d1NonNegativeIntegerOrNull(row.team_provider_id, 'standings team provider ID'),
        name: row.team_name,
        logo: row.team_logo ?? null,
      },
      points: d1NonNegativeIntegerOrNull(row.points, 'standings points'),
      goalDifference: d1IntegerOrNull(row.goal_difference, 'standings goal difference'),
      form: row.form ?? null,
      status: row.status ?? null,
      description: row.description ?? null,
      overall: standingsScope(row, 'overall'),
      home: standingsScope(row, 'home'),
      away: standingsScope(row, 'away'),
      updatedAt: row.updated_at ?? null,
      provenance: standingsProvenance(row, 'row'),
    });
    actualCount += 1;
  }
  if (actualCount !== expectedCount) throw new Error('D1 standings row count does not match its publication.');
  const actualDigest = await sha256Hex(standingsIdentityDigestInput(groups));
  if (actualDigest !== expectedDigest) throw new Error('D1 standings identity digest does not match its publication.');
  const payload = {
    contractVersion: rows[0].contract_version,
    competition: {
      id: identity.competition_id,
      providerId: d1NonNegativeIntegerOrNull(identity.competition_provider_id, 'competition provider ID'),
      name: identity.competition_name,
      country: identity.competition_country ?? null,
      logo: identity.competition_logo ?? null,
      flag: identity.competition_flag ?? null,
    },
    season: {
      id: identity.season_id,
      competitionId: identity.competition_id,
      providerSeason: d1NonNegativeIntegerOrNull(identity.provider_season, 'provider season'),
      label: identity.season_label ?? null,
    },
    groups,
    sectionStates: { standings: { presence: rows[0].section_presence } },
    generatedAt,
    provenance: standingsProvenance(rows[0], 'snapshot'),
  };
  assertValidStandingsPayload(payload, {
    expectedCompetitionId: competitionId,
    expectedSeasonId: requestedSeasonId,
  });
  return payload;
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  if (origin) headers.set('access-control-allow-origin', origin);
  headers.set('vary', 'Origin');
  headers.set('access-control-allow-methods', 'GET,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type');
  headers.set('access-control-expose-headers', 'x-jfw-data-source, x-jfw-cache');
  return new Response(response.body, { status: response.status, headers });
}

function withHeader(response, name, value) {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function dateResponseCache(env) {
  return env.RESPONSE_CACHE || globalThis.caches?.default || null;
}

function dateResponseCacheKey(date, competitionId) {
  const scope = competitionId === null ? 'all' : `competition/${encodeURIComponent(competitionId)}`;
  return new Request(`https://jfw.internal/cache/date-index/${scope}/${date}`);
}

function standingsResponseCacheKey(competitionId, requestedSeasonId) {
  return new Request(`https://jfw.internal/cache/standings/${encodeURIComponent(competitionId)}/${encodeURIComponent(requestedSeasonId)}`);
}

function fixtureDetailResponseCacheKey(fixtureId) {
  return new Request(`https://jfw.internal/cache/fixture-detail/${encodeURIComponent(fixtureId)}`);
}

async function cacheMatch(cache, key) {
  if (!cache || typeof cache.match !== 'function') return null;
  try {
    return await cache.match(key) || null;
  } catch {
    return null;
  }
}

async function cachePut(cache, key, response, context) {
  if (!cache || typeof cache.put !== 'function' || response.status !== 200) return;
  let operation;
  try {
    operation = Promise.resolve(cache.put(key, response.clone())).catch(() => {});
  } catch {
    return;
  }
  if (typeof context?.waitUntil === 'function') context.waitUntil(operation);
  else await operation;
}

function softRateLimit(request, env) {
  const limit = Math.max(1, Number(env.SOFT_RATE_LIMIT_PER_MINUTE || 120));
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const minute = Math.floor(Date.now() / 60000);
  const key = `${ip}:${minute}`;
  const count = (memoryRate.get(key) || 0) + 1;
  memoryRate.set(key, count);
  if (memoryRate.size > 5000) {
    for (const existing of memoryRate.keys()) if (!existing.endsWith(`:${minute}`)) memoryRate.delete(existing);
  }
  return count <= limit;
}

async function providerLive(env) {
  if (!env.API_FOOTBALL_KEY) return json({ error: 'API_FOOTBALL_KEY is not configured.' }, 503);
  const cache = caches.default;
  const scope = [...allowedCompetitionIds(env)].sort().join(',') || 'all';
  const cacheKey = new Request(`https://jfw.internal/cache/live?scope=${encodeURIComponent(scope)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const response = await fetch(`${API_BASE}/fixtures?live=all`, {
    headers: { 'x-apisports-key': env.API_FOOTBALL_KEY },
  });
  if (!response.ok) return json({ error: `API-Football HTTP ${response.status}` }, 502);
  const payload = await response.json();
  if (payload?.errors && (Array.isArray(payload.errors) ? payload.errors.length : Object.keys(payload.errors).length)) {
    return json({ error: 'API-Football returned an API-level error.' }, 502);
  }

  const projected = projectLiveFixtures(payload, env);
  const result = json(projected, 200, { 'cache-control': `public, max-age=${LIVE_TTL_SECONDS}` });
  await cache.put(cacheKey, result.clone());
  return result;
}

async function r2JsonObject(env, key, extraHeaders = {}) {
  if (!env.FOOTBALL_DATA) {
    return json({ error: 'FOOTBALL_DATA R2 binding is not configured.' }, 503, extraHeaders);
  }
  const object = await env.FOOTBALL_DATA.get(key);
  if (!object) return json({ error: 'Not found' }, 404, extraHeaders);
  const headers = new Headers(extraHeaders);
  headers.set('content-type', object.httpMetadata?.contentType || 'application/json; charset=utf-8');
  headers.set('cache-control', 'public, max-age=300');
  if (object.etag) headers.set('etag', object.etag);
  return new Response(object.body, { status: 200, headers });
}

async function degradedR2DateJsonObject(env, key, date, competitionId) {
  if (!env.FOOTBALL_DATA) {
    return json({ error: 'D1 read failed and FOOTBALL_DATA fallback is not configured.' }, 503,
      { 'x-jfw-data-source': 'unavailable' });
  }
  const object = await env.FOOTBALL_DATA.get(key);
  if (!object) {
    return json({ error: 'D1 read failed and no verified degraded snapshot exists.' }, 503,
      { 'x-jfw-data-source': 'unavailable' });
  }
  let payload;
  try {
    payload = JSON.parse(await object.text());
  } catch {
    return json({ error: 'D1 read failed and the degraded snapshot is invalid.' }, 503,
      { 'x-jfw-data-source': 'unavailable' });
  }
  try {
    assertValidDateIndexPayload(payload, {
      expectedDate: date,
      expectedCompetitionId: competitionId,
    });
  } catch {
    return json({ error: 'D1 read failed and the degraded snapshot failed entity validation.' }, 503,
      { 'x-jfw-data-source': 'unavailable' });
  }
  return json({ ...payload, degraded: true, lastSuccessfulAt: payload.generatedAt }, 200, {
    'cache-control': `public, max-age=${DEGRADED_TTL_SECONDS}`,
    'x-jfw-data-source': 'r2-degraded',
  });
}

async function degradedR2StandingsObject(env, key, competitionId, requestedSeasonId) {
  if (!env.FOOTBALL_DATA) {
    return json({ error: 'D1 read failed and FOOTBALL_DATA fallback is not configured.' }, 503,
      { 'x-jfw-data-source': 'unavailable' });
  }
  const object = await env.FOOTBALL_DATA.get(key);
  if (!object) {
    return json({ error: 'D1 read failed and no verified degraded snapshot exists.' }, 503,
      { 'x-jfw-data-source': 'unavailable' });
  }
  let payload;
  try {
    payload = JSON.parse(await object.text());
    assertValidStandingsPayload(payload, {
      expectedCompetitionId: competitionId,
      expectedSeasonId: requestedSeasonId,
    });
  } catch {
    return json({ error: 'D1 read failed and the degraded standings snapshot is invalid.' }, 503,
      { 'x-jfw-data-source': 'unavailable' });
  }
  return json({ ...payload, degraded: true, lastSuccessfulAt: payload.generatedAt }, 200, {
    'cache-control': `public, max-age=${DEGRADED_TTL_SECONDS}`,
    'x-jfw-data-source': 'r2-degraded',
  });
}

async function dateIndexResponse(env, date, competitionId = null, context = null) {
  const flag = competitionId === null
    ? 'D1_DATE_INDEX_ENABLED' : 'D1_COMPETITION_DATE_INDEX_ENABLED';
  const r2Key = competitionId === null
    ? dateIndexKey(date) : competitionDateIndexKey(competitionId, date);
  if (!enabled(env, flag)) return r2JsonObject(env, r2Key);
  const cache = dateResponseCache(env);
  const cacheKey = dateResponseCacheKey(date, competitionId);
  const cached = await cacheMatch(cache, cacheKey);
  if (cached) return withHeader(cached, 'x-jfw-cache', 'hit');
  try {
    const feed = await buildD1DateFeed(env, date, competitionId);
    if (feed === null) {
      return r2JsonObject(env, r2Key, { 'x-jfw-data-source': 'r2-not-migrated' });
    }
    const response = json(feed, 200, {
      'cache-control': `public, max-age=${DATE_TTL_SECONDS}`,
      'x-jfw-data-source': 'd1',
      'x-jfw-cache': 'miss',
    });
    await cachePut(cache, cacheKey, response, context);
    return response;
  } catch (error) {
    if (error?.code === 'D1_COMPETITION_NOT_FOUND') {
      return json({ error: 'Competition not found' }, 404,
        { 'x-jfw-data-source': 'd1' });
    }
    const response = await degradedR2DateJsonObject(env, r2Key, date, competitionId);
    await cachePut(cache, cacheKey, response, context);
    return withHeader(response, 'x-jfw-cache', 'miss');
  }
}

async function standingsResponse(env, competitionId, requestedSeasonId, context = null) {
  const key = standingsLatestKey(competitionId, requestedSeasonId);
  if (!enabled(env, 'D1_STANDINGS_ENABLED')) return r2JsonObject(env, key);
  const cache = dateResponseCache(env);
  const cacheKey = standingsResponseCacheKey(competitionId, requestedSeasonId);
  const cached = await cacheMatch(cache, cacheKey);
  if (cached) return withHeader(cached, 'x-jfw-cache', 'hit');
  try {
    const payload = await buildD1Standings(env, competitionId, requestedSeasonId);
    if (payload === null) return r2JsonObject(env, key, { 'x-jfw-data-source': 'r2-not-migrated' });
    const response = json(payload, 200, {
      'cache-control': `public, max-age=${STANDINGS_TTL_SECONDS}`,
      'x-jfw-data-source': 'd1',
      'x-jfw-cache': 'miss',
    });
    await cachePut(cache, cacheKey, response, context);
    return response;
  } catch (error) {
    if (error?.code === 'D1_COMPETITION_NOT_FOUND' || error?.code === 'D1_SEASON_NOT_FOUND') {
      return json({ error: error.code === 'D1_COMPETITION_NOT_FOUND'
        ? 'Competition not found' : 'Competition season not found' }, 404,
      { 'x-jfw-data-source': 'd1' });
    }
    const response = await degradedR2StandingsObject(env, key, competitionId, requestedSeasonId);
    await cachePut(cache, cacheKey, response, context);
    return withHeader(response, 'x-jfw-cache', 'miss');
  }
}

// The D1 read path reconstructs this DTO column by column, so its shape is
// closed by construction. Any R2-sourced payload must be held to the same closed
// set, or the r2 and r2-degraded paths would serve fields the d1 path cannot,
// breaking parity and letting publisher-side fields reach clients verbatim.
// detailAvailability was added with contract 2.1.0. Artifacts published before it
// are still valid in R2 and must not be rejected, so it is allowed but not
// required. Everything else is required at both versions.
const FIXTURE_DETAIL_OPTIONAL_ROOT_FIELDS = new Set(['detailAvailability']);
const FIXTURE_DETAIL_DEGRADED_OPTIONAL_FIELDS = new Set(['fixture.reconciledAt']);

function assertClosedFixtureDetailValue(value, schema, pathName, contractVersion, optionalFields) {
  if (!schema || schema.type === 'any') return;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`Fixture detail ${pathName} is not an array.`);
    for (const item of value) {
      assertClosedFixtureDetailValue(item, schema.items, `${pathName}[]`, contractVersion, optionalFields);
    }
    return;
  }
  if (schema.type !== 'object') return;
  // A few generated DTO objects, notably lineup coach, are nullable. Null has no
  // keys to leak; the entity checks below continue to enforce required identities.
  if (value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Fixture detail ${pathName || 'root'} is not an object.`);
  }
  if (schema.additionalProperties) {
    for (const [key, item] of Object.entries(value)) {
      assertClosedFixtureDetailValue(
        item, schema.additionalProperties, `${pathName}.${key}`, contractVersion, optionalFields,
      );
    }
    return;
  }
  const allowed = new Set(Object.keys(schema.properties));
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) {
    throw new Error(`Fixture detail ${pathName || 'root'} contains fields outside the closed contract: ${unknown.join(', ')}.`);
  }
  for (const [key, childSchema] of Object.entries(schema.properties)) {
    const fieldPath = pathName ? `${pathName}.${key}` : key;
    const legacyOptional = !pathName && contractVersion === '2.0.0'
      && FIXTURE_DETAIL_OPTIONAL_ROOT_FIELDS.has(key);
    if (!Object.hasOwn(value, key)) {
      if (legacyOptional || optionalFields.has(fieldPath)) continue;
      throw new Error(`Fixture detail is missing ${fieldPath}.`);
    }
    assertClosedFixtureDetailValue(value[key], childSchema, fieldPath, contractVersion, optionalFields);
  }
}

function assertFixtureDetailPayload(payload, fixtureId, { degraded = false } = {}) {
  const fixture = payload?.fixture;
  if (!payload || (payload.contractVersion !== '2.0.0' && payload.contractVersion !== '2.1.0')) {
    throw new Error('Fixture detail contract version is unsupported.');
  }
  assertClosedFixtureDetailValue(
    payload,
    FIXTURE_DETAIL_SCHEMA,
    '',
    payload.contractVersion,
    degraded ? FIXTURE_DETAIL_DEGRADED_OPTIONAL_FIELDS : new Set(),
  );
  if (!fixture || fixture.id !== fixtureId) throw new Error('Fixture detail identity does not match the requested fixture.');
  if (!fixture.competitionId?.startsWith('af:competition:')) throw new Error('Fixture detail competition identity is invalid.');
  if (!fixture.seasonId?.startsWith('af:season:')) throw new Error('Fixture detail season identity is invalid.');
  if (!fixture.kickoffUtc || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fixture.kickoffUtc)) {
    throw new Error('Fixture detail kickoffUtc is not canonical.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fixture.dateJst || ''))) {
    throw new Error('Fixture detail dateJst is invalid.');
  }
  if (!payload.competition || payload.competition.id !== fixture.competitionId) {
    throw new Error('Fixture detail competition scope is inconsistent.');
  }
  if (!payload.season || payload.season.id !== fixture.seasonId
      || payload.season.competitionId !== fixture.competitionId) {
    throw new Error('Fixture detail season scope is inconsistent.');
  }
  if (payload.detailAvailability !== undefined
      && payload.detailAvailability !== 'available'
      && payload.detailAvailability !== 'unavailable') {
    throw new Error('Fixture detail availability is invalid.');
  }
  for (const key of ['lineups', 'events', 'teamStats', 'playerStats']) {
    if (!Array.isArray(payload[key])) throw new Error(`Fixture detail ${key} is not an array.`);
  }
  if (!payload.sectionStates || typeof payload.sectionStates !== 'object' || Array.isArray(payload.sectionStates)) {
    throw new Error('Fixture detail sectionStates is invalid.');
  }
  return payload;
}

async function r2FixturePayload(env, fixtureId, { degraded = false } = {}) {
  if (!env.FOOTBALL_DATA) {
    return json({ error: degraded
      ? 'D1 read failed and FOOTBALL_DATA fallback is not configured.'
      : 'FOOTBALL_DATA R2 binding is not configured.' }, degraded ? 503 : 503, {
      'x-jfw-data-source': 'unavailable',
    });
  }
  const pointerObject = await env.FOOTBALL_DATA.get(fixturePointerKey(fixtureId));
  if (!pointerObject) return json({ error: degraded ? 'D1 read failed and no verified fixture snapshot exists.' : 'Fixture not found' }, degraded ? 503 : 404,
    degraded ? { 'x-jfw-data-source': 'unavailable' } : {});
  let pointer;
  try {
    pointer = JSON.parse(await pointerObject.text());
  } catch {
    return json({ error: degraded ? 'D1 read failed and the fixture pointer is invalid.' : 'Fixture pointer is invalid' }, degraded ? 503 : 500,
      degraded ? { 'x-jfw-data-source': 'unavailable' } : {});
  }
  if (pointer?.fixtureId && pointer.fixtureId !== fixtureId) {
    return json({ error: degraded ? 'D1 read failed and the fixture pointer has the wrong identity.' : 'Fixture pointer identity is invalid' }, degraded ? 503 : 500,
      degraded ? { 'x-jfw-data-source': 'unavailable' } : {});
  }
  if (!pointer?.key) return json({ error: degraded ? 'D1 read failed and the fixture pointer is missing its canonical key.' : 'Fixture pointer is missing canonical key' }, degraded ? 503 : 500,
    degraded ? { 'x-jfw-data-source': 'unavailable' } : {});
  const object = await env.FOOTBALL_DATA.get(pointer.key);
  if (!object) return json({ error: degraded ? 'D1 read failed and the fixture snapshot is missing.' : 'Not found' }, degraded ? 503 : 404,
    degraded ? { 'x-jfw-data-source': 'unavailable' } : {});
  let payload;
  try {
    payload = JSON.parse(await object.text());
    assertFixtureDetailPayload(payload, fixtureId, { degraded });
  } catch {
    return json({ error: degraded ? 'D1 read failed and the fixture snapshot failed entity validation.' : 'Fixture snapshot is invalid' }, degraded ? 503 : 500,
      degraded ? { 'x-jfw-data-source': 'unavailable' } : {});
  }
  // Fixture snapshots do not have the root generatedAt used by date/standings.
  // reconciledAt is the time this exact fixture revision was last reconciled and
  // published, so it is the fixture endpoint's last successful snapshot time.
  const reconciledAt = payload.fixture.reconciledAt;
  const hasCanonicalReconciledAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
    String(reconciledAt || ''),
  );
  const result = degraded
    ? {
      ...payload,
      degraded: true,
      ...(hasCanonicalReconciledAt ? { lastSuccessfulAt: reconciledAt } : {}),
    }
    : payload;
  return json(result, 200, {
    'cache-control': `public, max-age=${degraded ? DEGRADED_TTL_SECONDS : FIXTURE_DETAIL_TTL_SECONDS}`,
    'x-jfw-data-source': degraded ? 'r2-degraded' : 'r2',
  });
}

async function r2FixtureArchivePayload(env, archive, fixtureId) {
  if (!env.FOOTBALL_DATA || !archive?.key) throw new Error('Fixture archive is not available.');
  const object = await env.FOOTBALL_DATA.get(archive.key);
  if (!object) throw new Error('Fixture archive object is missing.');
  const text = await object.text();
  if (archive.contentSha256) {
    const actual = await sha256BytesHex(new TextEncoder().encode(text));
    if (actual !== archive.contentSha256) throw new Error('Fixture archive content hash does not match D1 metadata.');
  }
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('Fixture archive JSON is invalid.'); }
  return assertFixtureDetailPayload(payload, fixtureId);
}

async function fixtureDetailResponse(env, fixtureId, context = null) {
  if (!enabled(env, 'D1_FIXTURE_DETAIL_ENABLED')) return r2FixturePayload(env, fixtureId);
  const cache = dateResponseCache(env);
  const cacheKey = fixtureDetailResponseCacheKey(fixtureId);
  const cached = await cacheMatch(cache, cacheKey);
  if (cached) return withHeader(cached, 'x-jfw-cache', 'hit');

  let response;
  try {
    if (!env.FOOTBALL_DB || typeof env.FOOTBALL_DB.prepare !== 'function') {
      throw new Error('FOOTBALL_DB D1 binding is not configured.');
    }
    const result = await new FixtureRepository(env.FOOTBALL_DB).resolveFixture(fixtureId);
    if (!result) {
      response = await r2FixturePayload(env, fixtureId);
      if (response.status === 200) response = withHeader(response, 'x-jfw-data-source', 'r2-not-migrated');
    } else if (result.source === 'r2') {
      const payload = await r2FixtureArchivePayload(env, result.archive, fixtureId);
      response = json(payload, 200, {
        'cache-control': `public, max-age=${FIXTURE_DETAIL_TTL_SECONDS}`,
        'x-jfw-data-source': 'd1',
        'x-jfw-cache': 'miss',
      });
    } else {
      assertFixtureDetailPayload(result.bundle, fixtureId);
      response = json(result.bundle, 200, {
        'cache-control': `public, max-age=${FIXTURE_DETAIL_TTL_SECONDS}`,
        'x-jfw-data-source': 'd1',
        'x-jfw-cache': 'miss',
      });
    }
  } catch (error) {
    response = await r2FixturePayload(env, fixtureId, { degraded: true });
    if (response.status === 200) response = withHeader(response, 'x-jfw-cache', 'miss');
    else if (error?.message) response = withHeader(response, 'x-jfw-error', 'unavailable');
  }
  await cachePut(cache, cacheKey, response, context);
  return response;
}

async function handle(request, env, context) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (url.pathname === '/health') return json({ ok: true, service: 'football-data-v2' });
  if (url.pathname === '/api/v2/live') return providerLive(env);

  const fixtureMatch = url.pathname.match(/^\/api\/v2\/fixtures\/(.+)$/);
  if (fixtureMatch) return fixtureDetailResponse(env, decodeURIComponent(fixtureMatch[1]), context);

  const dateMatch = url.pathname.match(/^\/api\/v2\/dates\/(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) return dateIndexResponse(env, dateMatch[1], null, context);

  const competitionDateMatch = url.pathname.match(/^\/api\/v2\/competitions\/([^/]+)\/dates\/(\d{4}-\d{2}-\d{2})$/);
  if (competitionDateMatch) {
    return dateIndexResponse(
      env,
      competitionDateMatch[2],
      decodeURIComponent(competitionDateMatch[1]),
      context,
    );
  }

  const standingsMatch = url.pathname.match(/^\/api\/v2\/competitions\/([^/]+)\/seasons\/([^/]+)\/standings$/);
  if (standingsMatch) {
    return standingsResponse(
      env,
      decodeURIComponent(standingsMatch[1]),
      decodeURIComponent(standingsMatch[2]),
      context,
    );
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env, context) {
    const origin = request.headers.get('origin');
    if (!isAllowedOrigin(origin, env)) return json({ error: 'Origin not allowed' }, 403);
    if (!softRateLimit(request, env)) return withCors(json({ error: 'Rate limit exceeded' }, 429), origin);
    const response = await handle(request, env, context);
    return withCors(response, origin);
  },
};
