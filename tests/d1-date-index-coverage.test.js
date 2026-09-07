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

function coveragePlan({
  date = '2026-08-22',
  datePath = 'indexes/date.json',
  competitions = [{
    competitionId: 'af:competition:39',
    path: 'indexes/competition.json',
  }],
} = {}) {
  return {
    schemaVersion: 'd1-date-index-coverage-plan/2',
    date,
    dateIndex: {
      path: datePath,
      sourceR2Key: `football/v2/indexes/date-jst/${date}.json`,
    },
    competitionIndexes: competitions.map(item => ({
      ...item,
      sourceR2Key: `football/v2/indexes/competition/${item.competitionId}/date-jst/${date}.json`,
    })),
  };
}

test('coverage importer validates exact generic and competition fixture sets before commit', async t => {
  const { importDateIndexCoverage } = await loadImporter();
  const database = databaseWithFixture();
  const directory = artifactDirectory(t);
  t.after(() => database.close());
  writeJson(directory, 'indexes/date.json', indexPayload());
  writeJson(directory, 'indexes/competition.json', indexPayload({ scoped: true }));

  const report = importDateIndexCoverage(database, coveragePlan(), directory);

  assert.equal(report.passed, true);
  assert.equal(report.productionReady, false);
  assert.equal(report.generic.fixtureCount, 1);
  assert.deepEqual(report.competitions.map(item => item.competitionId), ['af:competition:39']);
  assert.deepEqual({ ...database.prepare(`
    SELECT date_jst, fixture_count, generated_at, source_r2_key,
      length(source_sha256) AS hash_length, length(fixture_id_digest) AS digest_length
    FROM date_index_coverages`).get() }, {
    date_jst: '2026-08-22',
    fixture_count: 1,
    generated_at: '2026-08-21T22:00:00.000Z',
    source_r2_key: 'football/v2/indexes/date-jst/2026-08-22.json',
    hash_length: 64,
    digest_length: 64,
  });
  assert.deepEqual({ ...database.prepare(`
    SELECT fixture_count, source_r2_key
    FROM competition_date_index_coverages`).get() }, {
    fixture_count: 1,
    source_r2_key: 'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json',
  });

  writeJson(directory, 'indexes/date.json', indexPayload({ fixtures: [] }));
  assert.throws(() => importDateIndexCoverage(database, coveragePlan(), directory),
    /fixture identity set does not match D1/);
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

  importDateIndexCoverage(database, coveragePlan({ date: emptyDate }), directory);

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
  writeJson(directory, 'indexes/competition.json', indexPayload({ scoped: true }));

  assert.throws(() => importDateIndexCoverage(database, coveragePlan(), directory),
    /fixture identity set does not match D1/);
  assert.equal(database.prepare('SELECT count(*) AS count FROM date_index_coverages').get().count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM competition_date_index_coverages').get().count, 0);
});

test('coverage importer rejects artifacts outside the plan directory', async t => {
  const { importDateIndexCoverage } = await loadImporter();
  const database = databaseWithFixture();
  const directory = artifactDirectory(t);
  t.after(() => database.close());

  assert.throws(() => importDateIndexCoverage(database, coveragePlan({
    datePath: '../outside.json', competitions: [],
  }), directory), /escapes the plan directory/);
  assert.equal(database.prepare('SELECT count(*) AS count FROM date_index_coverages').get().count, 0);

  assert.throws(() => importDateIndexCoverage(database, coveragePlan({
    datePath: path.join(directory, 'indexes', 'date.json'), competitions: [],
  }), directory), /must be relative to the plan directory/);
});

test('generic coverage date cannot use SQLite primary-key NULL semantics', () => {
  const database = databaseWithFixture();
  try {
    assert.throws(() => database.prepare(`
      INSERT INTO date_index_coverages(
        date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
      ) VALUES (NULL, 0, ?1, ?2, ?3, ?4)`).run(
      'e'.repeat(64),
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
  importDateIndexCoverage(database, coveragePlan(), directory);

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

test('coverage plan supplies date and competition scope independently of artifact claims', async t => {
  const { importDateIndexCoverage } = await loadImporter();
  const database = databaseWithFixture();
  const directory = artifactDirectory(t);
  t.after(() => database.close());
  writeJson(directory, 'indexes/date.json', indexPayload());
  writeJson(directory, 'indexes/competition.json', indexPayload({ scoped: true }));

  assert.throws(() => importDateIndexCoverage(database, coveragePlan({ competitions: [] }), directory),
    /omits competitions with fixtures/);
  assert.throws(() => importDateIndexCoverage(database, coveragePlan({
    competitions: [{ competitionId: 'af:competition:140', path: 'indexes/competition.json' }],
  }), directory), /competition\.id must match af:competition:140/);

  const wrongKeyPlan = coveragePlan();
  wrongKeyPlan.dateIndex.sourceR2Key = 'football/v2/indexes/date-jst/2026-08-23.json';
  assert.throws(() => importDateIndexCoverage(database, wrongKeyPlan, directory),
    /sourceR2Key must match the declared date/);
  assert.equal(database.prepare('SELECT count(*) AS count FROM date_index_coverages').get().count, 0);
});

test('competition season re-parenting invalidates old and new scoped coverage', async t => {
  const { importDateIndexCoverage } = await loadImporter();
  const database = databaseWithFixture();
  const directory = artifactDirectory(t);
  t.after(() => database.close());
  database.exec(`
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, country_name, type)
      VALUES (2, 'af:competition:140', 1, 140, 'La Liga', 'Spain', 'League');
  `);
  writeJson(directory, 'indexes/date.json', indexPayload());
  writeJson(directory, 'indexes/competition.json', indexPayload({ scoped: true }));
  const laLiga = {
    id: 'af:competition:140', providerId: 140, name: 'La Liga',
    country: 'Spain', logo: null, flag: null,
  };
  writeJson(directory, 'indexes/competition-140.json', {
    ...indexPayload({ fixtures: [], scoped: false }), competition: laLiga,
  });
  importDateIndexCoverage(database, coveragePlan({ competitions: [
    { competitionId: 'af:competition:39', path: 'indexes/competition.json' },
    { competitionId: 'af:competition:140', path: 'indexes/competition-140.json' },
  ] }), directory);

  database.exec('UPDATE competition_seasons SET competition_id = 2 WHERE id = 1');

  assert.equal(database.prepare('SELECT count(*) AS count FROM date_index_coverages').get().count, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM competition_date_index_coverages').get().count, 0);
});

test('count-preserving competition season swap invalidates both scoped proofs', () => {
  const database = databaseWithFixture();
  try {
    database.exec(`
      INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, country_name, type)
        VALUES (2, 'af:competition:140', 1, 140, 'La Liga', 'Spain', 'League');
      INSERT INTO competition_seasons(
        id, canonical_id, competition_id, product_season_id, provider_season, label, status
      ) VALUES (2, 'af:season:140:2025', 2, 1, 2025, '2025', 'active');
      INSERT INTO fixtures(
        id, canonical_id, source_id, provider_id, competition_season_id,
        home_team_id, away_team_id, kickoff_utc, date_jst,
        status_short, status_long, ingestion_state
      ) VALUES (
        2, 'af:fixture:9002', 1, 9002, 2,
        1, 2, '2026-08-21T21:00:00.000Z', '2026-08-22',
        'NS', 'Not Started', 'scheduled'
      );
      INSERT INTO date_index_coverages(
        date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
      ) VALUES (
        '2026-08-22', 2, '${'a'.repeat(64)}', '2026-08-21T22:00:00.000Z',
        'football/v2/indexes/date-jst/2026-08-22.json', '${'b'.repeat(64)}'
      );
      INSERT INTO competition_date_index_coverages(
        competition_id, date_jst, fixture_count, fixture_id_digest,
        generated_at, source_r2_key, source_sha256
      ) VALUES
        (1, '2026-08-22', 1, '${'c'.repeat(64)}', '2026-08-21T22:00:00.000Z',
         'football/v2/indexes/competition/af:competition:39/date-jst/2026-08-22.json', '${'d'.repeat(64)}'),
        (2, '2026-08-22', 1, '${'e'.repeat(64)}', '2026-08-21T22:00:00.000Z',
         'football/v2/indexes/competition/af:competition:140/date-jst/2026-08-22.json', '${'f'.repeat(64)}');

      UPDATE competition_seasons SET competition_id = 2 WHERE id = 1;
      UPDATE competition_seasons SET competition_id = 1 WHERE id = 2;
    `);

    assert.equal(database.prepare(
      'SELECT count(*) AS count FROM competition_date_index_coverages',
    ).get().count, 0);
    assert.equal(database.prepare(
      'SELECT count(*) AS count FROM date_index_coverages',
    ).get().count, 1);
  } finally {
    database.close();
  }
});

test('INSERT OR REPLACE invalidates coverage for both the old and new fixture date', async t => {
  const { importDateIndexCoverage } = await loadImporter();
  const database = databaseWithFixture();
  const directory = artifactDirectory(t);
  t.after(() => database.close());
  writeJson(directory, 'indexes/date.json', indexPayload());
  writeJson(directory, 'indexes/competition.json', indexPayload({ scoped: true }));
  importDateIndexCoverage(database, coveragePlan(), directory);

  database.exec(`
    INSERT OR REPLACE INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id,
      home_team_id, away_team_id, kickoff_utc, date_jst,
      status_short, status_long, ingestion_state
    ) VALUES (
      1, 'af:fixture:9001', 1, 9001, 1,
      1, 2, '2026-08-22T20:00:00.000Z', '2026-08-23',
      'NS', 'Not Started', 'scheduled'
    );
  `);

  assert.equal(database.prepare(`
    SELECT count(*) AS count FROM date_index_coverages WHERE date_jst = '2026-08-22'`).get().count, 0);
});

test('coverage schema rejects impossible dates and non-canonical UTC instants', () => {
  const database = databaseWithFixture();
  const insert = database.prepare(`
    INSERT INTO date_index_coverages(
      date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
    ) VALUES (?1, 0, ?2, ?3, ?4, ?5)`);
  try {
    for (const invalidDate of ['abcd-ef-gh', '9999-99-99', '2026-02-30']) {
      assert.throws(() => insert.run(
        invalidDate, 'a'.repeat(64), '2026-08-21T22:00:00.000Z',
        `football/v2/indexes/date-jst/${invalidDate}.json`, 'b'.repeat(64),
      ), /CHECK constraint failed/);
    }
    for (const invalidInstant of [
      '2026-08-21T22:00:00Z', 'zzzz-zz-zzTzz:zz:zzZ', '2026-13-45T99:99:99.000Z',
    ]) {
      assert.throws(() => insert.run(
        '2026-08-23', 'a'.repeat(64), invalidInstant,
        'football/v2/indexes/date-jst/2026-08-23.json', 'b'.repeat(64),
      ), /CHECK constraint failed/);
    }
  } finally {
    database.close();
  }
});
