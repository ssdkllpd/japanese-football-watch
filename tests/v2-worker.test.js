'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { mergeDateIndex } = require('../scripts/v2/merge-date-index');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_d1_core.sql'), 'utf8');
const coverageMigration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '0002_d1_date_index_coverage.sql'),
  'utf8',
);

async function loadWorker() {
  return import('../worker/index.mjs');
}

function localD1(database, onPrepare = () => {}) {
  return {
    prepare(sql) {
      onPrepare(sql);
      const statement = database.prepare(sql);
      return {
        bind(...params) {
          return {
            async all() {
              return { success: true, results: statement.all(...params) };
            },
          };
        },
      };
    },
  };
}

function dateDatabase(options = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(migration);
  database.exec(coverageMigration);
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO competitions(
      id, canonical_id, source_id, provider_id, name, country_code, country_name, type,
      logo_url, flag_url
    ) VALUES (
      1, 'af:competition:39', 1, 39, 'Premier League', 'GB', 'England', 'League',
      'https://example.com/competition.png', 'https://example.com/flag.png'
    );
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
    INSERT INTO teams(id, canonical_id, source_id, provider_id, name, logo_url) VALUES
      (1, 'af:team:40', 1, 40, 'Home FC', 'https://example.com/home.png'),
      (2, 'af:team:50', 1, 50, 'Away FC', 'https://example.com/away.png');
    INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id,
      home_team_id, away_team_id, kickoff_utc, date_jst,
      status_short, status_long, status_elapsed, home_goals, away_goals,
      home_winner, away_winner, ingestion_state
    ) VALUES (
      1, 'af:fixture:9001', 1, 9001, 1,
      1, 2, '2026-08-21T20:00:00.000Z', '2026-08-22',
      'FT', 'Match Finished', 90, 0, 2, 0, 1, 'finalized'
    );
    INSERT INTO fixture_score_parts(fixture_id, score_kind, home_value, away_value) VALUES
      (1, 'halftime', 0, 1),
      (1, 'fulltime', 0, 2),
      (1, 'extratime', NULL, NULL),
      (1, 'penalty', NULL, NULL);
  `);
  if (options.coverage !== false) {
    database.exec(`
      INSERT INTO date_index_coverages(
        date_jst, fixture_count, generated_at, source_r2_key, source_sha256
      ) VALUES (
        '2026-08-22', 1, '2026-08-21T22:00:00.000Z',
        'football/v2/indexes/date-jst/2026-08-22.json', '${'a'.repeat(64)}'
      );
      INSERT INTO competition_date_index_coverages(
        competition_id, date_jst, fixture_count, generated_at, source_r2_key, source_sha256
      ) VALUES (
        1, '2026-08-22', 1, '2026-08-21T22:00:00.000Z',
        'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
        '${'b'.repeat(64)}'
      );
    `);
  }
  return database;
}

function indexedFixture() {
  return {
    fixtureId: 'af:fixture:9001',
    competitionId: 'af:competition:39',
    seasonId: 'af:season:39:2026',
    kickoffUtc: '2026-08-21T20:00:00.000Z',
    dateJst: '2026-08-22',
    status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
    ingestionState: 'finalized',
    teams: {
      home: { id: 'af:team:40', providerId: 40, name: 'Home FC',
        logo: 'https://example.com/home.png', winner: false },
      away: { id: 'af:team:50', providerId: 50, name: 'Away FC',
        logo: 'https://example.com/away.png', winner: true },
    },
    score: {
      goals: { home: 0, away: 2 },
      halftime: { home: 0, away: 1 },
      fulltime: { home: 0, away: 2 },
      extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
    competition: {
      id: 'af:competition:39', providerId: 39, name: 'Premier League', country: 'England',
      logo: 'https://example.com/competition.png', flag: 'https://example.com/flag.png',
    },
    competitionName: 'Premier League',
  };
}

function responseCache() {
  const entries = new Map();
  return {
    async match(request) { return entries.get(request.url)?.clone() || null; },
    async put(request, response) { entries.set(request.url, response.clone()); },
  };
}

function r2Object(payload, customMetadata = {}) {
  const body = JSON.stringify(payload);
  return {
    body,
    customMetadata,
    httpMetadata: { contentType: 'application/json' },
    async text() { return body; },
  };
}

function workerRequest(pathname) {
  return new Request(`https://worker.example${pathname}`, {
    headers: { origin: 'https://example.github.io' },
  });
}

test('live projection exposes only provider-independent DTO fields to the UI', async () => {
  const worker = await loadWorker();
  const payload = {
    response: [{
      fixture: {
        id: 123,
        date: '2026-08-21T20:00:00Z',
        status: { short: '2H', long: 'Second Half', elapsed: 63 },
        referee: 'must not leak into live DTO',
      },
      league: { id: 39, season: 2026, name: 'Premier League' },
      teams: {
        home: { id: 40, name: 'Home FC', logo: 'https://example.com/home.png' },
        away: { id: 50, name: 'Away FC', logo: 'https://example.com/away.png' },
      },
      goals: { home: 2, away: 1 },
      events: [{ shouldNotLeak: true }],
    }],
  };

  const dto = worker.projectLiveFixtures(payload, { LIVE_COMPETITION_IDS: '39' });
  assert.equal(dto.contractVersion, '2.0.0');
  assert.equal(dto.fixtures.length, 1);
  assert.deepEqual(dto.fixtures[0], {
    fixtureId: 'af:fixture:123',
    competitionId: 'af:competition:39',
    seasonId: 'af:season:39:2026',
    kickoffUtc: '2026-08-21T20:00:00.000Z',
    dateJst: '2026-08-22',
    status: { short: '2H', long: 'Second Half', elapsed: 63 },
    home: { teamId: 'af:team:40', name: 'Home FC', logo: 'https://example.com/home.png', score: 2 },
    away: { teamId: 'af:team:50', name: 'Away FC', logo: 'https://example.com/away.png', score: 1 },
  });
  assert.equal('events' in dto.fixtures[0], false);
  assert.equal('referee' in dto.fixtures[0], false);
});

test('live projection can be scoped by competition ID without name matching', async () => {
  const worker = await loadWorker();
  const rows = [
    { fixture: { id: 1 }, league: { id: 39, season: 2026 }, teams: {}, goals: {} },
    { fixture: { id: 2 }, league: { id: 140, season: 2026 }, teams: {}, goals: {} },
  ];
  const dto = worker.projectLiveFixtures(rows, { LIVE_COMPETITION_IDS: '140' });
  assert.deepEqual(dto.fixtures.map(row => row.fixtureId), ['af:fixture:2']);
});

test('origin allowlist is explicit and no-origin access requires an opt-in', async () => {
  const worker = await loadWorker();
  const env = { APP_ORIGINS: 'https://example.github.io,https://app.example.com' };
  assert.equal(worker.isAllowedOrigin('https://example.github.io', env), true);
  assert.equal(worker.isAllowedOrigin('https://evil.example', env), false);
  assert.equal(worker.isAllowedOrigin(null, env), false);
  assert.equal(worker.isAllowedOrigin(null, { ...env, ALLOW_NO_ORIGIN: 'true' }), true);
});

test('R2 lookup keys are deterministic', async () => {
  const worker = await loadWorker();
  assert.equal(worker.fixturePointerKey('af:fixture:123'), 'football/v2/indexes/fixture/af:fixture:123.json');
  assert.equal(worker.dateIndexKey('2026-08-22'), 'football/v2/indexes/date-jst/2026-08-22.json');
  assert.equal(
    worker.competitionDateIndexKey('af:competition:39', '2026-08-22'),
    'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
  );
  assert.equal(
    worker.standingsLatestKey('af:competition:39', 'af:season:39:2026'),
    'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/standings/latest.json',
  );
});

test('competition date route reads the competition-scoped R2 index', async () => {
  const worker = await loadWorker();
  const requested = [];
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    FOOTBALL_DATA: {
      async get(key) {
        requested.push(key);
        return {
          body: JSON.stringify({ date: '2026-08-22', fixtures: [] }),
          httpMetadata: { contentType: 'application/json' },
          etag: 'test-etag',
        };
      },
    },
  };
  const request = new Request('https://worker.example/api/v2/competitions/af%3Acompetition%3A39/dates/2026-08-22', {
    headers: { origin: 'https://example.github.io' },
  });
  const response = await worker.default.fetch(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(requested, ['football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json']);
});

test('standings route reads the latest competition-season snapshot', async () => {
  const worker = await loadWorker();
  const requested = [];
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    FOOTBALL_DATA: {
      async get(key) {
        requested.push(key);
        return {
          body: JSON.stringify({ groups: [] }),
          httpMetadata: { contentType: 'application/json' },
        };
      },
    },
  };
  const request = new Request(
    'https://worker.example/api/v2/competitions/af%3Acompetition%3A39/seasons/af%3Aseason%3A39%3A2026/standings',
    { headers: { origin: 'https://example.github.io' } },
  );
  const response = await worker.default.fetch(request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(requested, [
    'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/standings/latest.json',
  ]);
});

test('date endpoint keeps the existing R2 path when its D1 flag is absent', async () => {
  const worker = await loadWorker();
  let d1Reads = 0;
  const payload = {
    contractVersion: '2.0.0', timeZone: 'Asia/Tokyo', date: '2026-08-22',
    fixtures: [], generatedAt: '2026-08-21T22:00:00.000Z',
  };
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    FOOTBALL_DB: { prepare() { d1Reads += 1; throw new Error('must remain off'); } },
    FOOTBALL_DATA: { async get() { return r2Object(payload); } },
  };

  const response = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);

  assert.equal(response.status, 200);
  assert.equal(d1Reads, 0);
  assert.deepEqual(await response.json(), payload);
  assert.equal(response.headers.get('x-jfw-data-source'), null);
});

test('enabled date endpoint builds the response from bounded D1 queries', async t => {
  const worker = await loadWorker();
  const database = dateDatabase();
  t.after(() => database.close());
  let queryCount = 0;
  let dateQuery = null;
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: localD1(database, sql => { queryCount += 1; dateQuery = sql; }),
    FOOTBALL_DATA: { async get() { throw new Error('R2 must not be read'); } },
  };

  const response = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(queryCount, 1);
  const queryPlan = database.prepare(`EXPLAIN QUERY PLAN ${dateQuery}`)
    .all('2026-08-22')
    .map(row => row.detail)
    .join('\n');
  assert.match(queryPlan, /SEARCH fixture USING INDEX idx_fixtures_date_kickoff/);
  assert.doesNotMatch(queryPlan, /SCAN fixture(?:\s|$)/);
  assert.equal(response.headers.get('x-jfw-data-source'), 'd1');
  assert.equal(body.generatedAt, '2026-08-21T22:00:00.000Z');
  assert.deepEqual(body.fixtures, [indexedFixture()]);
});

test('competition-date D1 flag is independent and preserves competition metadata', async t => {
  const worker = await loadWorker();
  const database = dateDatabase();
  t.after(() => database.close());
  let queryCount = 0;
  const prepared = [];
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_COMPETITION_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: localD1(database, sql => { queryCount += 1; prepared.push(sql); }),
  };

  const response = await worker.default.fetch(workerRequest(
    '/api/v2/competitions/af%3Acompetition%3A39/dates/2026-08-22',
  ), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(queryCount, 2);
  const fixtureQueryPlan = database.prepare(`EXPLAIN QUERY PLAN ${prepared[1]}`)
    .all('af:competition:39', '2026-08-22')
    .map(row => row.detail)
    .join('\n');
  assert.match(fixtureQueryPlan, /SEARCH fixture USING INDEX idx_fixtures_competition_date_kickoff/);
  assert.doesNotMatch(fixtureQueryPlan, /SCAN fixture(?:\s|$)/);
  assert.equal(response.headers.get('x-jfw-data-source'), 'd1');
  assert.deepEqual(body.competition, {
    id: 'af:competition:39', providerId: 39, name: 'Premier League', country: 'England',
    logo: 'https://example.com/competition.png', flag: 'https://example.com/flag.png',
  });
  assert.deepEqual(body.fixtures.map(fixture => fixture.fixtureId), ['af:fixture:9001']);
});

test('D1 date failure returns the same verified R2 entity as an observable degraded response', async () => {
  const worker = await loadWorker();
  const requested = [];
  const payload = {
    contractVersion: '2.0.0', timeZone: 'Asia/Tokyo', date: '2026-08-22',
    fixtures: [indexedFixture()],
    generatedAt: '2026-08-21T22:00:00.000Z',
  };
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: { prepare() { throw new Error('injected D1 failure'); } },
    FOOTBALL_DATA: { async get(key) { requested.push(key); return r2Object(payload); } },
  };

  const response = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jfw-data-source'), 'r2-degraded');
  assert.deepEqual(requested, ['football/v2/indexes/date-jst/2026-08-22.json']);
  assert.equal(body.degraded, true);
  assert.equal(body.lastSuccessfulAt, payload.generatedAt);
  assert.deepEqual(body.fixtures, payload.fixtures);
});

test('D1 date failure does not substitute another entity or hide a missing fallback', async () => {
  const worker = await loadWorker();
  const requested = [];
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: { prepare() { throw new Error('injected D1 failure'); } },
    FOOTBALL_DATA: { async get(key) { requested.push(key); return null; } },
  };

  const response = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-jfw-data-source'), 'unavailable');
  assert.deepEqual(requested, ['football/v2/indexes/date-jst/2026-08-22.json']);
  assert.match((await response.json()).error, /no verified degraded snapshot/);
});

test('D1 date failure rejects an R2 snapshot for a different date', async () => {
  const payload = {
    contractVersion: '2.0.0', timeZone: 'Asia/Tokyo', date: '2026-08-23',
    fixtures: [], generatedAt: '2026-08-21T22:00:00.000Z',
  };
  const worker = await loadWorker();
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: { prepare() { throw new Error('injected D1 failure'); } },
    FOOTBALL_DATA: { async get() { return r2Object(payload); } },
  };

  const response = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-jfw-data-source'), 'unavailable');
  assert.match((await response.json()).error, /failed entity validation/);
});

test('D1 date failure rejects a scope-matching but incomplete R2 fixture DTO', async () => {
  const payload = {
    contractVersion: '2.0.0', timeZone: 'Asia/Tokyo', date: '2026-08-22',
    fixtures: [{ fixtureId: 'af:fixture:9001', competitionId: 'af:competition:39',
      dateJst: '2026-08-22' }],
    generatedAt: '2026-08-21T22:00:00.000Z',
  };
  const worker = await loadWorker();
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: { prepare() { throw new Error('injected D1 failure'); } },
    FOOTBALL_DATA: { async get() { return r2Object(payload); } },
  };

  const response = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-jfw-data-source'), 'unavailable');
  assert.match((await response.json()).error, /failed entity validation/);
});

test('D1 date path fails closed instead of coercing a corrupt numeric value to null', async t => {
  const worker = await loadWorker();
  const database = dateDatabase();
  t.after(() => database.close());
  database.exec("UPDATE fixtures SET status_elapsed = 'invalid' WHERE id = 1");
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: localD1(database),
    FOOTBALL_DATA: { async get() { return null; } },
  };

  const response = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-jfw-data-source'), 'unavailable');
  assert.match((await response.json()).error, /no verified degraded snapshot/);
});

test('competition-date D1 failure accepts the real merged publisher artifact for only that entity', async () => {
  const worker = await loadWorker();
  const requested = [];
  const payload = await mergeDateIndex(null, {
    contractVersion: '2.0.0', timeZone: 'Asia/Tokyo', date: '2026-08-22',
    competition: indexedFixture().competition,
    fixtures: [indexedFixture()],
    generatedAt: '2026-08-21T22:00:00.000Z',
  });
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_COMPETITION_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: { prepare() { throw new Error('injected D1 failure'); } },
    FOOTBALL_DATA: { async get(key) { requested.push(key); return r2Object(payload); } },
  };

  const response = await worker.default.fetch(workerRequest(
    '/api/v2/competitions/af%3Acompetition%3A39/dates/2026-08-22',
  ), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jfw-data-source'), 'r2-degraded');
  assert.deepEqual(requested, [
    'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
  ]);
  assert.equal(body.degraded, true);
  assert.equal(body.lastSuccessfulAt, payload.generatedAt);
  assert.equal(body.competition.id, 'af:competition:39');
});

test('enabled D1 date path uses the edge response cache after one bounded read', async t => {
  const worker = await loadWorker();
  const database = dateDatabase();
  t.after(() => database.close());
  let queryCount = 0;
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: localD1(database, () => { queryCount += 1; }),
    FOOTBALL_DATA: { async get() { throw new Error('R2 must not be read'); } },
    RESPONSE_CACHE: responseCache(),
  };

  const first = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);
  const second = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);

  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-jfw-cache'), 'miss');
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-jfw-cache'), 'hit');
  assert.equal(second.headers.get('access-control-expose-headers'), 'x-jfw-data-source, x-jfw-cache');
  assert.equal(queryCount, 1);
  assert.deepEqual(await second.json(), await first.json());
});

test('edge cache failure never turns a valid D1 response into degraded mode', async t => {
  const worker = await loadWorker();
  const database = dateDatabase();
  t.after(() => database.close());
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: localD1(database),
    FOOTBALL_DATA: { async get() { throw new Error('R2 must not be read'); } },
    RESPONSE_CACHE: {
      async match() { return null; },
      put() { throw new Error('injected cache failure'); },
    },
  };

  const response = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jfw-data-source'), 'd1');
  assert.equal((await response.json()).fixtures.length, 1);
});

test('missing D1 coverage preserves the old R2 missing-versus-empty semantics', async t => {
  const worker = await loadWorker();
  const database = dateDatabase({ coverage: false });
  t.after(() => database.close());
  const requested = [];
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: localD1(database),
    FOOTBALL_DATA: { async get(key) { requested.push(key); return null; } },
  };

  const response = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-22'), env);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-jfw-data-source'), 'r2-not-migrated');
  assert.deepEqual(requested, ['football/v2/indexes/date-jst/2026-08-22.json']);
});

test('explicit generic and competition empty coverage returns a D1 200 instead of not-migrated', async t => {
  const worker = await loadWorker();
  const database = dateDatabase({ coverage: false });
  t.after(() => database.close());
  database.exec(`
    INSERT INTO date_index_coverages(
      date_jst, fixture_count, generated_at, source_r2_key, source_sha256
    ) VALUES (
      '2026-08-23', 0, '2026-08-22T22:00:00.000Z',
      'football/v2/indexes/date-jst/2026-08-23.json', '${'c'.repeat(64)}'
    );
    INSERT INTO competition_date_index_coverages(
      competition_id, date_jst, fixture_count, generated_at, source_r2_key, source_sha256
    ) VALUES (
      1, '2026-08-23', 0, '2026-08-22T22:00:00.000Z',
      'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-23.json',
      '${'d'.repeat(64)}'
    );
  `);
  let r2Reads = 0;
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_DATE_INDEX_ENABLED: 'true',
    D1_COMPETITION_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: localD1(database),
    FOOTBALL_DATA: { async get() { r2Reads += 1; return null; } },
  };

  const generic = await worker.default.fetch(workerRequest('/api/v2/dates/2026-08-23'), env);
  const scoped = await worker.default.fetch(workerRequest(
    '/api/v2/competitions/af%3Acompetition%3A39/dates/2026-08-23',
  ), env);
  const genericBody = await generic.json();
  const scopedBody = await scoped.json();

  assert.equal(generic.status, 200);
  assert.equal(scoped.status, 200);
  assert.equal(generic.headers.get('x-jfw-data-source'), 'd1');
  assert.equal(scoped.headers.get('x-jfw-data-source'), 'd1');
  assert.deepEqual(genericBody.fixtures, []);
  assert.deepEqual(scopedBody.fixtures, []);
  assert.equal(scopedBody.competition.id, 'af:competition:39');
  assert.equal(r2Reads, 0);
});

test('unknown D1 competition is a 404 and does not trigger an unrelated R2 fallback', async t => {
  const worker = await loadWorker();
  const database = dateDatabase();
  t.after(() => database.close());
  let r2Reads = 0;
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_COMPETITION_DATE_INDEX_ENABLED: 'true',
    FOOTBALL_DB: localD1(database),
    FOOTBALL_DATA: { async get() { r2Reads += 1; return null; } },
  };

  const response = await worker.default.fetch(workerRequest(
    '/api/v2/competitions/af%3Acompetition%3A999/dates/2026-08-22',
  ), env);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-jfw-data-source'), 'd1');
  assert.equal(r2Reads, 0);
});
