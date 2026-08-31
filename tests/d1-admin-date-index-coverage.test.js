'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
    INSERT INTO teams(id, canonical_id, source_id, provider_id, name) VALUES
      (1, 'af:team:40', 1, 40, 'Home FC'),
      (2, 'af:team:50', 1, 50, 'Away FC');
    INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id,
      home_team_id, away_team_id, kickoff_utc, date_jst,
      status_short, status_long, status_elapsed, home_goals, away_goals,
      home_winner, away_winner, ingestion_state
    ) VALUES (
      1, 'af:fixture:9001', 1, 9001, 1, 1, 2,
      '2026-08-21T20:00:00.000Z', '2026-08-22',
      'FT', 'Match Finished', 90, 0, 2, 0, 1, 'finalized'
    );
  `);
  return db;
}

function competition(id = 'af:competition:39', providerId = 39) {
  return { id, providerId, name: 'Premier League', country: 'England', logo: null, flag: null };
}

function fixture() {
  return {
    fixtureId: 'af:fixture:9001', competitionId: 'af:competition:39',
    seasonId: 'af:season:39:2026', kickoffUtc: '2026-08-21T20:00:00.000Z',
    dateJst: '2026-08-22',
    status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
    ingestionState: 'finalized',
    teams: {
      home: { id: 'af:team:40', providerId: 40, name: 'Home FC', logo: null, winner: false },
      away: { id: 'af:team:50', providerId: 50, name: 'Away FC', logo: null, winner: true },
    },
    score: {
      goals: { home: 0, away: 2 }, halftime: { home: null, away: null },
      fulltime: { home: 0, away: 2 }, extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
    competition: competition(), competitionName: 'Premier League',
  };
}

function payload({ date = '2026-08-22', fixtures = [fixture()], scoped = false,
  generatedAt = '2026-08-21T22:00:00.000Z' } = {}) {
  const result = {
    contractVersion: '2.0.0', timeZone: 'Asia/Tokyo', date, fixtures, generatedAt,
  };
  if (scoped) result.competition = competition();
  return result;
}

function body(date = '2026-08-22', competitionIds = ['af:competition:39']) {
  return {
    schemaVersion: 'jfw-d1-admin-ingest/1', operation: 'date_index_coverage_publish',
    date, competitionIds,
  };
}

function request(value) {
  return new Request('https://admin.example/admin/v1/ingest', {
    method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

function environment(db, artifacts) {
  return {
    ADMIN_INGEST_TOKEN: 'test-token', FOOTBALL_DB: createLocalD1(db),
    FOOTBALL_DATA: {
      async get(key) {
        if (!Object.hasOwn(artifacts, key)) return null;
        const raw = JSON.stringify(artifacts[key]);
        return { async text() { return raw; } };
      },
    },
  };
}

function artifacts({ date = '2026-08-22', generic = payload({ date }),
  scoped = payload({ date, scoped: true }) } = {}) {
  return {
    [`football/v2/indexes/date-jst/${date}.json`]: generic,
    [`football/v2/indexes/competition/af:competition:39/date-jst/${date}.json`]: scoped,
  };
}

function coverageRows(db) {
  return {
    generic: db.prepare(`
      SELECT date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
      FROM date_index_coverages ORDER BY date_jst
    `).all(),
    competitions: db.prepare(`
      SELECT competition.canonical_id AS competition_id, coverage.date_jst,
        coverage.fixture_count, coverage.fixture_id_digest, coverage.generated_at,
        coverage.source_r2_key, coverage.source_sha256
      FROM competition_date_index_coverages coverage
      JOIN competitions competition ON competition.id = coverage.competition_id
      ORDER BY competition.canonical_id, coverage.date_jst
    `).all(),
  };
}

test('admin coverage publish validates R2 against D1 and preserves verified empty dates', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  const initialArtifacts = artifacts();
  const env = environment(db, initialArtifacts);
  const batch = env.FOOTBALL_DB.batch;
  let statementCount = 0;
  env.FOOTBALL_DB.batch = async statements => {
    statementCount = statements.length;
    return batch(statements);
  };
  let response = await admin.default.fetch(request(body()), env);
  assert.equal(response.status, 200);
  let result = await response.json();
  assert.equal(result.report.productionReady, false);
  assert.equal(result.report.generic.fixtureCount, 1);
  assert.deepEqual(result.report.competitions.map(item => item.competitionId), ['af:competition:39']);
  assert.equal(statementCount <= 10, true, `D1 statement budget: ${statementCount}`);
  assert.equal(db.prepare(`
    SELECT fixture_count FROM date_index_coverages WHERE date_jst='2026-08-22'
  `).get().fixture_count, 1);
  assert.equal(db.prepare(`
    SELECT fixture_count FROM competition_date_index_coverages WHERE date_jst='2026-08-22'
  `).get().fixture_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_runs').get().count, 0);

  const reviewedLocal = database();
  t.after(() => reviewedLocal.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-admin-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'date.json'), JSON.stringify(
    initialArtifacts['football/v2/indexes/date-jst/2026-08-22.json'],
  ));
  fs.writeFileSync(path.join(directory, 'competition.json'), JSON.stringify(
    initialArtifacts['football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json'],
  ));
  const localImporter = await import('../scripts/d1/import-date-index-coverage.mjs');
  localImporter.importDateIndexCoverage(reviewedLocal, {
    schemaVersion: 'd1-date-index-coverage-plan/2',
    date: '2026-08-22',
    dateIndex: {
      path: 'date.json',
      sourceR2Key: 'football/v2/indexes/date-jst/2026-08-22.json',
    },
    competitionIndexes: [{
      competitionId: 'af:competition:39',
      path: 'competition.json',
      sourceR2Key: 'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
    }],
  }, directory);
  assert.deepEqual(coverageRows(db), coverageRows(reviewedLocal));

  const emptyDate = '2026-08-23';
  const emptyArtifacts = artifacts({
    date: emptyDate,
    generic: payload({ date: emptyDate, fixtures: [] }),
    scoped: payload({ date: emptyDate, fixtures: [], scoped: true }),
  });
  response = await admin.default.fetch(request(body(emptyDate)), environment(db, emptyArtifacts));
  assert.equal(response.status, 200);
  result = await response.json();
  assert.equal(result.report.generic.fixtureCount, 0);
  assert.equal(db.prepare(`
    SELECT fixture_count FROM date_index_coverages WHERE date_jst=?
  `).get(emptyDate).fixture_count, 0);
});

test('admin coverage publish rejects omitted or self-declared competition scope without writes', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  let response = await admin.default.fetch(request(body('2026-08-22', [])), environment(db, artifacts()));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM date_index_coverages').get().count, 0);

  const wrong = payload({ scoped: true });
  wrong.competition = competition('af:competition:140', 140);
  response = await admin.default.fetch(request(body()), environment(db, artifacts({ scoped: wrong })));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM competition_date_index_coverages').get().count, 0);

  const wrongGeneric = payload();
  wrongGeneric.fixtures[0] = {
    ...wrongGeneric.fixtures[0],
    competitionId: 'af:competition:140',
    seasonId: 'af:season:140:2026',
    competition: competition('af:competition:140', 140),
  };
  response = await admin.default.fetch(request(body()), environment(db, artifacts({
    generic: wrongGeneric,
  })));
  assert.equal(response.status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM date_index_coverages').get().count, 0);
});

test('admin coverage integrity assertion preserves the prior proof after silent competition underwrite', async t => {
  const db = database();
  t.after(() => db.close());
  const admin = await import('../admin-worker/index.mjs');
  let response = await admin.default.fetch(request(body()), environment(db, artifacts()));
  assert.equal(response.status, 200);
  const before = db.prepare(`
    SELECT generated_at, source_sha256 FROM date_index_coverages WHERE date_jst='2026-08-22'
  `).get();

  const newer = '2026-08-21T23:00:00.000Z';
  const changed = artifacts({
    generic: payload({ generatedAt: newer }),
    scoped: payload({ scoped: true, generatedAt: newer }),
  });
  const env = environment(db, changed);
  const prepare = env.FOOTBALL_DB.prepare;
  env.FOOTBALL_DB.prepare = sql => {
    if (!sql.includes('INSERT INTO competition_date_index_coverages')) return prepare(sql);
    return {
      bind() {
        return { async run() { return { success: true, meta: { changes: 0 } }; } };
      },
    };
  };
  response = await admin.default.fetch(request(body()), env);
  assert.equal(response.status, 422);
  assert.deepEqual({ ...db.prepare(`
    SELECT generated_at, source_sha256 FROM date_index_coverages WHERE date_jst='2026-08-22'
  `).get() }, { ...before });
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM competition_date_index_coverages WHERE date_jst='2026-08-22'
  `).get().count, 1);
});
