'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const coreMigration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '0001_d1_core.sql'),
  'utf8',
);
const coverageMigration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '0002_d1_date_index_coverage.sql'),
  'utf8',
);

async function loadImporter() {
  return import('../scripts/d1/import-date-index-coverage.mjs');
}

function databaseWithFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(coreMigration);
  database.exec(coverageMigration);
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO competitions(
      id, canonical_id, source_id, provider_id, name, country_name, type
    ) VALUES (1, 'af:competition:39', 1, 39, 'Premier League', 'England', 'League');
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
      1, 'af:fixture:9001', 1, 9001, 1,
      1, 2, '2026-08-21T20:00:00.000Z', '2026-08-22',
      'FT', 'Match Finished', 90, 0, 2, 0, 1, 'finalized'
    );
  `);
  return database;
}

function competition() {
  return {
    id: 'af:competition:39', providerId: 39, name: 'Premier League',
    country: 'England', logo: null, flag: null,
  };
}

function fixture() {
  return {
    fixtureId: 'af:fixture:9001',
    competitionId: 'af:competition:39',
    seasonId: 'af:season:39:2026',
    kickoffUtc: '2026-08-21T20:00:00.000Z',
    dateJst: '2026-08-22',
    status: { short: 'FT', long: 'Match Finished', elapsed: 90 },
    ingestionState: 'finalized',
    teams: {
      home: { id: 'af:team:40', providerId: 40, name: 'Home FC', logo: null, winner: false },
      away: { id: 'af:team:50', providerId: 50, name: 'Away FC', logo: null, winner: true },
    },
    score: {
      goals: { home: 0, away: 2 },
      halftime: { home: null, away: null },
      fulltime: { home: 0, away: 2 },
      extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
    competition: competition(),
    competitionName: 'Premier League',
  };
}

function indexPayload({ date = '2026-08-22', fixtures = [fixture()], scoped = false } = {}) {
  const payload = {
    contractVersion: '2.0.0',
    timeZone: 'Asia/Tokyo',
    date,
    fixtures,
    generatedAt: '2026-08-21T22:00:00.000Z',
  };
  if (scoped) payload.competition = competition();
  return payload;
}

function artifactDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jfw-date-coverage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'indexes'));
  return directory;
}

function writeJson(directory, relativePath, payload) {
  fs.writeFileSync(
    path.join(directory, relativePath),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

test('coverage importer validates exact generic and competition fixture sets before commit', async t => {
  const { importDateIndexCoverage } = await loadImporter();
  const database = databaseWithFixture();
  const directory = artifactDirectory(t);
  t.after(() => database.close());
  writeJson(directory, 'indexes/date.json', indexPayload());
  writeJson(directory, 'indexes/competition.json', indexPayload({ scoped: true }));

  const report = importDateIndexCoverage(database, {
    schemaVersion: 'd1-date-index-coverage-plan/1',
    dateIndex: 'indexes/date.json',
    competitionIndexes: ['indexes/competition.json'],
  }, directory);

  assert.equal(report.passed, true);
  assert.equal(report.productionReady, false);
  assert.equal(report.generic.fixtureCount, 1);
  assert.deepEqual(report.competitions.map(item => item.competitionId), ['af:competition:39']);
  assert.deepEqual({ ...database.prepare(`
    SELECT date_jst, fixture_count, generated_at, source_r2_key, length(source_sha256) AS hash_length
    FROM date_index_coverages`).get() }, {
    date_jst: '2026-08-22',
    fixture_count: 1,
    generated_at: '2026-08-21T22:00:00.000Z',
    source_r2_key: 'football/v2/indexes/date-jst/2026-08-22.json',
    hash_length: 64,
  });
  assert.deepEqual({ ...database.prepare(`
    SELECT fixture_count, source_r2_key
    FROM competition_date_index_coverages`).get() }, {
    fixture_count: 1,
    source_r2_key: 'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
  });

  writeJson(directory, 'indexes/date.json', indexPayload({ fixtures: [] }));
  assert.throws(() => importDateIndexCoverage(database, {
    schemaVersion: 'd1-date-index-coverage-plan/1',
    dateIndex: 'indexes/date.json',
    competitionIndexes: [],
  }, directory), /fixture identity set does not match D1/);
  assert.equal(database.prepare(`
    SELECT fixture_count FROM date_index_coverages WHERE date_jst = '2026-08-22'`).get().fixture_count, 1);
  assert.equal(database.prepare(`
    SELECT fixture_count FROM competition_date_index_coverages WHERE date_jst = '2026-08-22'`).get().fixture_count, 1);
});

test('coverage importer can distinguish an explicitly fetched empty date', async t => {
  const { importDateIndexCoverage } = await loadImporter();
  const database = databaseWithFixture();
  const directory = artifactDirectory(t);
  t.after(() => database.close());
  const emptyDate = '2026-08-23';
  writeJson(directory, 'indexes/date.json', indexPayload({ date: emptyDate, fixtures: [] }));
  writeJson(directory, 'indexes/competition.json', indexPayload({
    date: emptyDate, fixtures: [], scoped: true,
  }));

  importDateIndexCoverage(database, {
    schemaVersion: 'd1-date-index-coverage-plan/1',
    dateIndex: 'indexes/date.json',
    competitionIndexes: ['indexes/competition.json'],
  }, directory);

  assert.equal(database.prepare(`
    SELECT fixture_count FROM date_index_coverages WHERE date_jst = ?1`).get(emptyDate).fixture_count, 0);
  assert.equal(database.prepare(`
    SELECT fixture_count FROM competition_date_index_coverages WHERE date_jst = ?1`).get(emptyDate).fixture_count, 0);
});

test('coverage importer rejects fixture-set drift without writing partial coverage', async t => {
  const { importDateIndexCoverage } = await loadImporter();
  const database = databaseWithFixture();
  const directory = artifactDirectory(t);
  t.after(() => database.close());
  writeJson(directory, 'indexes/date.json', indexPayload({ fixtures: [] }));

  assert.throws(() => importDateIndexCoverage(database, {
    schemaVersion: 'd1-date-index-coverage-plan/1',
    dateIndex: 'indexes/date.json',
    competitionIndexes: [],
  }, directory), /fixture identity set does not match D1/);
  assert.equal(database.prepare('SELECT count(*) AS count FROM date_index_coverages').get().count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM competition_date_index_coverages').get().count, 0);
});

test('coverage importer rejects artifacts outside the plan directory', async t => {
  const { importDateIndexCoverage } = await loadImporter();
  const database = databaseWithFixture();
  const directory = artifactDirectory(t);
  t.after(() => database.close());

  assert.throws(() => importDateIndexCoverage(database, {
    schemaVersion: 'd1-date-index-coverage-plan/1',
    dateIndex: '../outside.json',
    competitionIndexes: [],
  }, directory), /escapes the plan directory/);
  assert.equal(database.prepare('SELECT count(*) AS count FROM date_index_coverages').get().count, 0);

  assert.throws(() => importDateIndexCoverage(database, {
    schemaVersion: 'd1-date-index-coverage-plan/1',
    dateIndex: path.join(directory, 'indexes', 'date.json'),
    competitionIndexes: [],
  }, directory), /must be relative to the plan directory/);
});

test('generic coverage date cannot use SQLite primary-key NULL semantics', () => {
  const database = databaseWithFixture();
  try {
    assert.throws(() => database.prepare(`
      INSERT INTO date_index_coverages(
        date_jst, fixture_count, generated_at, source_r2_key, source_sha256
      ) VALUES (NULL, 0, ?1, ?2, ?3)`).run(
      '2026-08-21T22:00:00.000Z',
      'football/v2/indexes/date-jst/invalid.json',
      'e'.repeat(64),
    ), /NOT NULL constraint failed/);
  } finally {
    database.close();
  }
});

test('fixture identity writes invalidate generic and competition coverage', async t => {
  const { importDateIndexCoverage } = await loadImporter();
  const database = databaseWithFixture();
  const directory = artifactDirectory(t);
  t.after(() => database.close());
  writeJson(directory, 'indexes/date.json', indexPayload());
  writeJson(directory, 'indexes/competition.json', indexPayload({ scoped: true }));
  importDateIndexCoverage(database, {
    schemaVersion: 'd1-date-index-coverage-plan/1',
    dateIndex: 'indexes/date.json',
    competitionIndexes: ['indexes/competition.json'],
  }, directory);

  database.exec(`
    UPDATE fixtures
    SET canonical_id = canonical_id,
        competition_season_id = competition_season_id,
        date_jst = date_jst
    WHERE id = 1;
  `);
  assert.equal(database.prepare('SELECT count(*) AS count FROM date_index_coverages').get().count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM competition_date_index_coverages').get().count, 1);

  database.exec('PRAGMA foreign_keys = OFF');

  database.exec(`
    INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id,
      home_team_id, away_team_id, kickoff_utc, date_jst,
      status_short, status_long, ingestion_state
    ) VALUES (
      2, 'af:fixture:9002', 1, 9002, 1,
      1, 2, '2026-08-21T21:00:00.000Z', '2026-08-22',
      'NS', 'Not Started', 'scheduled'
    );
  `);

  assert.equal(database.prepare('SELECT count(*) AS count FROM date_index_coverages').get().count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM competition_date_index_coverages').get().count, 0);
});
