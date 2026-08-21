const API_BASE = 'https://v3.football.api-sports.io';
const LIVE_TTL_SECONDS = 60;
const memoryRate = new Map();

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
  return new Response(response.body, { status: response.status, headers });
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

async function r2JsonObject(env, key) {
  if (!env.FOOTBALL_DATA) return json({ error: 'FOOTBALL_DATA R2 binding is not configured.' }, 503);
  const object = await env.FOOTBALL_DATA.get(key);
  if (!object) return json({ error: 'Not found' }, 404);
  const headers = new Headers();
  headers.set('content-type', object.httpMetadata?.contentType || 'application/json; charset=utf-8');
  headers.set('cache-control', 'public, max-age=300');
  if (object.etag) headers.set('etag', object.etag);
  return new Response(object.body, { status: 200, headers });
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

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (url.pathname === '/health') return json({ ok: true, service: 'football-data-v2' });
  if (url.pathname === '/api/v2/live') return providerLive(env);

  const fixtureMatch = url.pathname.match(/^\/api\/v2\/fixtures\/(.+)$/);
  if (fixtureMatch) return fixtureFromR2(env, decodeURIComponent(fixtureMatch[1]));

  const dateMatch = url.pathname.match(/^\/api\/v2\/dates\/(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) return r2JsonObject(env, dateIndexKey(dateMatch[1]));

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin');
    if (!isAllowedOrigin(origin, env)) return json({ error: 'Origin not allowed' }, 403);
    if (!softRateLimit(request, env)) return withCors(json({ error: 'Rate limit exceeded' }, 429), origin);
    const response = await handle(request, env);
    return withCors(response, origin);
  },
};
