'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createLocalD1 } = require('../scripts/d1/local-d1');

const migrations = [
  '0001_d1_core.sql',
  '0002_d1_date_index_coverage.sql',
  '0003_d1_standings_publication.sql',
].map(file => fs.readFileSync(path.join(__dirname, '..', 'migrations', file), 'utf8'));

async function loadImporter() {
  return import('../scripts/d1/import-standings.mjs');
}

async function loadWorker() {
  return import('../worker/index.mjs');
}

function database() {
  const db = new DatabaseSync(':memory:');
  for (const migration of migrations) db.exec(migration);
  db.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO competitions(
      id, canonical_id, source_id, provider_id, name, country_name, type
    ) VALUES (1, 'af:competition:39', 1, 39, 'Old name', 'England', 'League');
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (1, 'af:season:39:2026', 1, 1, 2026, 'old', 'active');
  `);
  return db;
}

function provenance() {
  return {
    source: 'api-football',
    fetchedAt: '2026-08-31T06:00:00.000Z',
    verification: 'provider',
    issues: [],
  };
}

function scope(played, wins, draws, losses, goalsFor, goalsAgainst) {
  return { played, wins, draws, losses, goalsFor, goalsAgainst };
}

function standingRow({ rank, teamId, providerId, name, points, goalDifference }) {
  return {
    rank,
    team: { id: teamId, providerId, name, logo: `https://example.com/${providerId}.png` },
    points,
    goalDifference,
    form: rank === 1 ? 'WWDWW' : null,
    status: rank === 1 ? 'same' : null,
    description: null,
    overall: scope(2, rank === 1 ? 2 : 0, rank === 1 ? 0 : 1, rank === 1 ? 0 : 1, rank === 1 ? 5 : 1, rank === 1 ? 1 : 4),
    home: scope(1, rank === 1 ? 1 : 0, rank === 1 ? 0 : 1, 0, rank === 1 ? 3 : 1, rank === 1 ? 0 : 1),
    away: scope(1, rank === 1 ? 1 : 0, 0, rank === 1 ? 0 : 1, rank === 1 ? 2 : 0, rank === 1 ? 1 : 3),
    updatedAt: '2026-08-31T05:55:00.000Z',
    provenance: provenance(),
  };
}

function payload() {
  return {
    contractVersion: '2.0.0',
    competition: {
      id: 'af:competition:39', providerId: 39, name: 'Premier League', country: 'England',
      logo: 'https://example.com/competition.png', flag: 'https://example.com/flag.png',
    },
    season: {
      id: 'af:season:39:2026', competitionId: 'af:competition:39',
      providerSeason: 2026, label: '2026',
    },
    groups: [{
      id: 'group:1',
      name: 'Table',
      table: [
        standingRow({ rank: 1, teamId: 'af:team:40', providerId: 40, name: 'First FC', points: 6, goalDifference: 4 }),
        standingRow({ rank: 2, teamId: 'af:team:50', providerId: 50, name: 'Second FC', points: 1, goalDifference: -3 }),
      ],
    }],
    sectionStates: { standings: { presence: 'present' } },
    generatedAt: '2026-08-31T06:00:00.000Z',
    provenance: provenance(),
  };
}

function artifact(t, value = payload()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-standings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'standings.json'), raw);
  return {
    directory,
    raw,
    plan: {
      schemaVersion: 'd1-standings-import-plan/1',
      standings: [{
        competitionId: 'af:competition:39',
        seasonId: 'af:season:39:2026',
        path: 'standings.json',
        sourceR2Key: 'football/v2/competitions/af:competition:39/seasons/af:season:39:2026/standings/latest.json',
      }],
    },
  };
}

function r2Object(value) {
  const body = JSON.stringify(value);
  return {
    body,
    httpMetadata: { contentType: 'application/json' },
    async text() { return body; },
  };
}

test('standings importer and D1 Worker read preserve the complete public DTO', async t => {
  const { importStandingsPlan } = await loadImporter();
  const worker = await loadWorker();
  const db = database();
  t.after(() => db.close());
  const input = artifact(t);

  const report = importStandingsPlan(db, input.plan, input.directory);
  assert.equal(report.passed, true);
  assert.equal(report.standings[0].rowCount, 2);
  assert.equal(report.standings[0].artifactSha256,
    crypto.createHash('sha256').update(input.raw).digest('hex'));

  const result = await worker.buildD1Standings(
    { FOOTBALL_DB: createLocalD1(db) },
    'af:competition:39',
    'af:season:39:2026',
  );
  assert.deepEqual(result, payload());
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM teams').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM competition_season_teams').get().count, 2);
});

test('standings mutation invalidates the published snapshot before it can be served', async t => {
  const { importStandingsPlan } = await loadImporter();
  const worker = await loadWorker();
  const db = database();
  t.after(() => db.close());
  const input = artifact(t);
  importStandingsPlan(db, input.plan, input.directory);

  db.exec('UPDATE standings_rows SET points = 99 WHERE rank = 1');

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 0);
  assert.equal(await worker.buildD1Standings(
    { FOOTBALL_DB: createLocalD1(db) }, 'af:competition:39', 'af:season:39:2026'), null);
});

test('failed standings reimport preserves the previously published snapshot', async t => {
  const { importStandingsPlan } = await loadImporter();
  const worker = await loadWorker();
  const db = database();
  t.after(() => db.close());
  const valid = artifact(t);
  importStandingsPlan(db, valid.plan, valid.directory);
  const drift = payload();
  drift.competition.id = 'af:competition:140';
  const invalid = artifact(t, drift);

  assert.throws(() => importStandingsPlan(db, invalid.plan, invalid.directory), /competition/);
  assert.deepEqual(await worker.buildD1Standings(
    { FOOTBALL_DB: createLocalD1(db) }, 'af:competition:39', 'af:season:39:2026'), payload());
});

test('enabled standings route uses D1 and fails over only to a validated same-scope R2 snapshot', async t => {
  const { importStandingsPlan } = await loadImporter();
  const worker = await loadWorker();
  const db = database();
  t.after(() => db.close());
  const input = artifact(t);
  importStandingsPlan(db, input.plan, input.directory);
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    D1_STANDINGS_ENABLED: 'true',
    FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: { async get() { return r2Object(payload()); } },
  };
  const request = new Request(
    'https://worker.example/api/v2/competitions/af%3Acompetition%3A39/seasons/af%3Aseason%3A39%3A2026/standings',
    { headers: { origin: 'https://example.github.io' } },
  );
  let response = await worker.default.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jfw-data-source'), 'd1');
  assert.deepEqual(await response.json(), payload());

  db.exec('DROP TRIGGER standings_publication_invalidate_row_update');
  db.exec('UPDATE standings_rows SET points = 1.5 WHERE rank = 1');
  response = await worker.default.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-jfw-data-source'), 'r2-degraded');
  assert.equal((await response.json()).degraded, true);

  env.FOOTBALL_DATA = { async get() {
    const wrong = payload();
    wrong.season.id = 'af:season:39:2025';
    return r2Object(wrong);
  } };
  response = await worker.default.fetch(request, env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-jfw-data-source'), 'unavailable');
});

test('unknown competition-season does not fall back to an unrelated R2 object', async t => {
  const worker = await loadWorker();
  const db = database();
  t.after(() => db.close());
  let r2Reads = 0;
  const response = await worker.default.fetch(new Request(
    'https://worker.example/api/v2/competitions/af%3Acompetition%3A39/seasons/af%3Aseason%3A39%3A2025/standings',
    { headers: { origin: 'https://example.github.io' } },
  ), {
    APP_ORIGINS: 'https://example.github.io',
    D1_STANDINGS_ENABLED: 'true',
    FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: { async get() { r2Reads += 1; return r2Object(payload()); } },
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-jfw-data-source'), 'd1');
  assert.equal(r2Reads, 0);
});

test('a season re-parent invalidates the standings publication instead of serving another competition', async t => {
  const { importStandingsPlan } = await loadImporter();
  const worker = await loadWorker();
  const db = database();
  t.after(() => db.close());
  db.exec(`
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, country_name, type)
      VALUES (2, 'af:competition:140', 1, 140, 'La Liga', 'Spain', 'League');
  `);
  const input = artifact(t);
  importStandingsPlan(db, input.plan, input.directory);

  db.exec('UPDATE competition_seasons SET competition_id = 2 WHERE id = 1');

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 0);
  assert.equal(await worker.buildD1Standings(
    { FOOTBALL_DB: createLocalD1(db) }, 'af:competition:140', 'af:season:39:2026'), null);
});

test('a competition identity change invalidates the standings publication', async t => {
  const { importStandingsPlan } = await loadImporter();
  const db = database();
  t.after(() => db.close());
  const input = artifact(t);
  importStandingsPlan(db, input.plan, input.directory);

  db.exec("UPDATE competitions SET canonical_id = 'af:competition:140' WHERE id = 1");

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM standings_publications').get().count, 0);
});

test('a publication may not point at a snapshot belonging to another season', async t => {
  const { importStandingsPlan } = await loadImporter();
  const db = database();
  t.after(() => db.close());
  db.exec(`
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, country_name, type)
      VALUES (2, 'af:competition:140', 1, 140, 'La Liga', 'Spain', 'League');
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (2, 'af:season:140:2026', 2, 1, 2026, 'other', 'active');
  `);
  const input = artifact(t);
  importStandingsPlan(db, input.plan, input.directory);
  const snapshotId = db.prepare('SELECT snapshot_id AS id FROM standings_publications').get().id;

  assert.throws(() => db.exec(`
    INSERT INTO standings_publications(
      competition_season_id, snapshot_id, row_count, identity_digest, generated_at,
      source_r2_key, source_sha256
    ) VALUES (2, ${snapshotId}, 2, '${'a'.repeat(64)}', '2026-08-31T06:00:00.000Z', 'k', '${'b'.repeat(64)}')
  `), /does not match its snapshot season/);
});

test('date and instant columns reject values SQLite cannot resolve to a real calendar date', async t => {
  const db = database();
  t.after(() => db.close());
  const digest = 'a'.repeat(64);
  for (const dateJst of ['2026-13-01', '2026-19-01', '2026-09-32', '2026-02-30']) {
    assert.throws(() => db.exec(`
      INSERT INTO date_index_coverages(
        date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
      ) VALUES ('${dateJst}', 0, '${digest}', '2026-08-31T06:00:00.000Z', 'k', '${digest}')
    `), /CHECK constraint failed/, dateJst);
  }
  assert.throws(() => db.exec(`
    INSERT INTO date_index_coverages(
      date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
    ) VALUES ('2026-09-01', 0, '${digest}', '2026-13-01T00:00:00.000Z', 'k', '${digest}')
  `), /CHECK constraint failed/);
});
