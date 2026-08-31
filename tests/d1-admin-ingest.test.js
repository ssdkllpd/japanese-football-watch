'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createLocalD1 } = require('../scripts/d1/local-d1');

const migrations = ['0001_d1_core.sql', '0002_d1_date_index_coverage.sql', '0003_d1_standings_publication.sql']
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'migrations', file), 'utf8'));

function database() {
  const db = new DatabaseSync(':memory:');
  for (const migration of migrations) db.exec(migration);
  db.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, country_name, type)
      VALUES (1, 'af:competition:39', 1, 39, 'Premier League', 'England', 'League');
    INSERT INTO competition_seasons(id, canonical_id, competition_id, product_season_id, provider_season, label, status)
      VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
  `);
  return db;
}

function provenance() {
  return { source: 'api-football', fetchedAt: '2026-08-31T06:00:00.000Z', verification: 'provider', issues: [] };
}

function scope(played, wins, draws, losses, goalsFor, goalsAgainst) {
  return { played, wins, draws, losses, goalsFor, goalsAgainst };
}

function row(rank, providerId, name, points, goalDifference) {
  return {
    rank, team: { id: `af:team:${providerId}`, providerId, name, logo: null }, points, goalDifference,
    form: null, status: null, description: null,
    overall: scope(2, rank === 1 ? 2 : 0, rank === 1 ? 0 : 1, 0, rank === 1 ? 4 : 1, rank === 1 ? 1 : 3),
    home: scope(1, rank === 1 ? 1 : 0, rank === 1 ? 0 : 1, 0, rank === 1 ? 2 : 1, rank === 1 ? 0 : 1),
    away: scope(1, rank === 1 ? 1 : 0, 0, rank === 1 ? 0 : 1, rank === 1 ? 2 : 0, rank === 1 ? 1 : 2),
    updatedAt: '2026-08-31T05:55:00.000Z', provenance: provenance(),
  };
}

function payload() {
  return {
    contractVersion: '2.0.0',
    competition: { id: 'af:competition:39', providerId: 39, name: 'Premier League', country: 'England', logo: null, flag: null },
    season: { id: 'af:season:39:2026', competitionId: 'af:competition:39', providerSeason: 2026, label: '2026' },
    groups: [{ id: 'table', name: 'Table', table: [row(1, 40, 'First FC', 6, 3), row(2, 50, 'Second FC', 1, -2)] }],
    sectionStates: { standings: { presence: 'present' } }, generatedAt: '2026-08-31T06:00:00.000Z', provenance: provenance(),
  };
}

function env(db, artifact = payload()) {
  const key = 'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/standings/latest.json';
  const raw = JSON.stringify(artifact);
  return {
    ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: { async get(requested) { return requested === key ? { async text() { return raw; } } : null; } },
  };
}

function request(body, token = 'test-token') {
  return new Request('https://admin.example/admin/v1/ingest', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function ingestBody() {
  return {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'standings_publish',
    competitionId: 'af:competition:39', seasonId: 'af:season:39:2026',
  };
}

test('admin standings ingest reads the canonical R2 object and atomically publishes a D1 snapshot', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const worker = await import('../worker/index.mjs');
  const response = await admin.default.fetch(request(ingestBody()), env(db));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.report.rowCount, 2);
  assert.match(body.report.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 1);
  assert.deepEqual(await worker.buildD1Standings(
    { FOOTBALL_DB: createLocalD1(db) }, 'af:competition:39', 'af:season:39:2026',
  ), payload());
});

test('admin ingest rejects unauthenticated, wrong-scope, and unavailable source requests before publishing', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  let response = await admin.default.fetch(request(ingestBody(), 'wrong-token'), env(db));
  assert.equal(response.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 0);

  const wrong = payload();
  wrong.competition.id = 'af:competition:140';
  response = await admin.default.fetch(request(ingestBody()), env(db, wrong));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 0);

  const unavailable = env(db);
  unavailable.FOOTBALL_DATA = { async get() { return null; } };
  response = await admin.default.fetch(request(ingestBody()), unavailable);
  assert.equal(response.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 0);
});

test('a failed reimport preserves the previously published standings snapshot', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  await admin.default.fetch(request(ingestBody()), env(db));
  const previous = db.prepare('SELECT source_sha256 FROM standings_publications').get().source_sha256;
  const invalid = payload();
  invalid.groups[0].table[1].team.providerId = 40;
  const response = await admin.default.fetch(request(ingestBody()), env(db, invalid));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT source_sha256 FROM standings_publications').get().source_sha256, previous);
});
