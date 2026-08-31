'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createLocalD1 } = require('../scripts/d1/local-d1');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_d1_core.sql'), 'utf8');

function databaseWithFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(migration);
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, country_name, type)
      VALUES (1, 'af:competition:39', 1, 39, 'Premier League', 'England', 'League');
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
    INSERT INTO teams(id, canonical_id, source_id, provider_id, name)
      VALUES (1, 'af:team:40', 1, 40, 'Home FC'), (2, 'af:team:50', 1, 50, 'Away FC');
    INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id,
      home_team_id, away_team_id, kickoff_utc, date_jst, status_short,
      status_long, ingestion_state
    ) VALUES (
      1, 'af:fixture:9001', 1, 9001, 1, 1, 2,
      '2026-08-21T20:00:00.000Z', '2026-08-22', 'NS', 'Not Started', 'scheduled'
    );
  `);
  return database;
}

function responseCache() {
  const entries = new Map();
  return {
    async match(request) { return entries.get(request.url)?.clone() || null; },
    async put(request, response) { entries.set(request.url, response.clone()); },
  };
}

function r2Object(payload) {
  const body = JSON.stringify(payload);
  return { body, httpMetadata: { contentType: 'application/json' }, async text() { return body; } };
}

function fixtureBundle(fixtureId = 'af:fixture:9001') {
  return {
    contractVersion: '2.1.0',
    detailAvailability: 'unavailable',
    fixture: {
      id: fixtureId, providerId: 9001, competitionId: 'af:competition:39',
      seasonId: 'af:season:39:2026', kickoffUtc: '2026-08-21T20:00:00.000Z',
      dateJst: '2026-08-22', status: { short: 'NS', long: 'Not Started', elapsed: null },
      teams: { home: { id: 'af:team:40' }, away: { id: 'af:team:50' } },
    },
    competition: { id: 'af:competition:39', providerId: 39, name: 'Premier League' },
    season: { id: 'af:season:39:2026', competitionId: 'af:competition:39', providerSeason: 2026 },
    lineups: [], events: [], teamStats: [], playerStats: [], sectionStates: {},
    overrides: {}, fieldIssues: {},
  };
}

function envWithR2(database, payload = fixtureBundle()) {
  const objects = new Map([
    ['football/v2/indexes/fixture/af:fixture:9001.json', r2Object({
      fixtureId: 'af:fixture:9001', key: 'football/v2/fixtures/9001.json',
    })],
    ['football/v2/fixtures/9001.json', r2Object(payload)],
  ]);
  return {
    APP_ORIGINS: 'https://example.github.io',
    D1_FIXTURE_DETAIL_ENABLED: 'true',
    FOOTBALL_DB: createLocalD1(database),
    FOOTBALL_DATA: { async get(key) { return objects.get(key) || null; } },
    RESPONSE_CACHE: responseCache(),
  };
}

function request() {
  return new Request('https://worker.example/api/v2/fixtures/af%3Afixture%3A9001', {
    headers: { origin: 'https://example.github.io' },
  });
}

test('fixture detail flag serves the D1 compact DTO without reading R2', async t => {
  const database = databaseWithFixture();
  t.after(() => database.close());
  const worker = await import('../worker/index.mjs');
  const env = envWithR2(database);
  let r2Reads = 0;
  const get = env.FOOTBALL_DATA.get;
  env.FOOTBALL_DATA.get = async key => { r2Reads += 1; return get(key); };

  const response = await worker.default.fetch(request(), env, { waitUntil() {} });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jfw-data-source'), 'd1');
  assert.equal(body.fixture.id, 'af:fixture:9001');
  assert.equal(body.detailAvailability, 'unavailable');
  assert.equal(r2Reads, 0);
});

test('fixture detail falls back only to a validated same-fixture R2 snapshot', async t => {
  const database = new DatabaseSync(':memory:');
  database.exec(migration);
  t.after(() => database.close());
  const worker = await import('../worker/index.mjs');
  const env = envWithR2(database);
  env.FOOTBALL_DB = { prepare() { throw new Error('simulated D1 outage'); } };
  const response = await worker.default.fetch(request(), env, { waitUntil() {} });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jfw-data-source'), 'r2-degraded');
  assert.equal(body.degraded, true);

  const wrong = envWithR2(database, fixtureBundle('af:fixture:9999'));
  wrong.FOOTBALL_DB = { prepare() { throw new Error('simulated D1 outage'); } };
  const rejected = await worker.default.fetch(request(), wrong, { waitUntil() {} });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error.includes('failed'), true);
});

test('fixture detail flag off keeps the existing pointer response and bypasses D1', async t => {
  const database = new DatabaseSync(':memory:');
  database.exec(migration);
  t.after(() => database.close());
  const worker = await import('../worker/index.mjs');
  const env = envWithR2(database);
  env.D1_FIXTURE_DETAIL_ENABLED = 'false';
  env.FOOTBALL_DB = { prepare() { throw new Error('D1 must not be read when flag is off'); } };
  const response = await worker.default.fetch(request(), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jfw-data-source'), null);
  assert.equal((await response.json()).fixture.id, 'af:fixture:9001');
});
