import {
  assertValidDateIndexPayload,
} from '../shared/date-index-contract.mjs';

const API_BASE = 'https://v3.football.api-sports.io';
const LIVE_TTL_SECONDS = 60;
const DATE_TTL_SECONDS = 300;
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
  SELECT date_jst, fixture_count, generated_at
  FROM date_index_coverages
  WHERE date_jst = ?1
)
SELECT
  coverage.fixture_count AS coverage_fixture_count,
  coverage.generated_at AS coverage_generated_at,
  ${FIXTURE_INDEX_COLUMNS_SQL}
FROM coverage
LEFT JOIN fixtures fixture ON fixture.date_jst = coverage.date_jst
${FIXTURE_INDEX_JOINS_SQL}
ORDER BY fixture.kickoff_utc, fixture.canonical_id`;

const COMPETITION_DATE_FIXTURES_SQL = `
WITH coverage AS (
  SELECT item.date_jst, item.fixture_count, item.generated_at, item.competition_id
  FROM competition_date_index_coverages item
  JOIN competitions scoped_competition ON scoped_competition.id = item.competition_id
  WHERE scoped_competition.canonical_id = ?1 AND item.date_jst = ?2
)
SELECT
  coverage.fixture_count AS coverage_fixture_count,
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

function booleanOrNull(value) {
  if (value === null || value === undefined) return null;
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new Error('D1 boolean value is outside the supported 0/1 domain.');
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
  if (!Number.isInteger(expectedCount) || expectedCount < 0) {
    throw new Error('D1 date coverage fixture count is invalid.');
  }
  if (fixtureRows.some(row => row.coverage_fixture_count !== expectedCount
      || row.coverage_generated_at !== generatedAt)) {
    throw new Error('D1 date coverage metadata is inconsistent.');
  }
  const fixtures = fixtureRows
    .filter(row => row.fixture_id !== null)
    .map(fixtureIndexEntryFromD1);
  if (fixtures.length !== expectedCount || new Set(fixtures.map(fixture => fixture.fixtureId)).size !== expectedCount) {
    throw new Error('D1 date coverage fixture count does not match stored fixtures.');
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

async function fixtureFromR2(env, fixtureId) {
  const pointerObject = await env.FOOTBALL_DATA?.get(fixturePointerKey(fixtureId));
  if (!pointerObject) return json({ error: 'Fixture not found' }, 404);
  let pointer;
  try {
    pointer = JSON.parse(await pointerObject.text());
  } catch {
    return json({ error: 'Fixture pointer is invalid' }, 500);
  }
  if (!pointer?.key) return json({ error: 'Fixture pointer is missing canonical key' }, 500);
  return r2JsonObject(env, pointer.key);
}

async function handle(request, env, context) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (url.pathname === '/health') return json({ ok: true, service: 'football-data-v2' });
  if (url.pathname === '/api/v2/live') return providerLive(env);

  const fixtureMatch = url.pathname.match(/^\/api\/v2\/fixtures\/(.+)$/);
  if (fixtureMatch) return fixtureFromR2(env, decodeURIComponent(fixtureMatch[1]));

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
    return r2JsonObject(
      env,
      standingsLatestKey(
        decodeURIComponent(standingsMatch[1]),
        decodeURIComponent(standingsMatch[2]),
      ),
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
