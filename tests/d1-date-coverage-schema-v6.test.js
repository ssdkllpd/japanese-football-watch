'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('../scripts/d1/migration-inventory');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migrations',
  '0006_d1_date_index_coverage_timestamp.sql'), 'utf8');

function openThroughV5() {
  const database = new DatabaseSync(':memory:');
  applyMigrations(database, root, { through: '0005_d1_player_passes_accurate.sql' });
  return database;
}

function seedCoverage(database) {
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, type)
      VALUES (1, 'af:competition:39', 1, 39, 'Premier League', 'League');
    INSERT INTO date_index_coverages(
      date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
    ) VALUES (
      '2026-08-01', 3, '${'a'.repeat(64)}', '2026-09-08T02:15:09.068Z',
      'migration/date/2026-08-01.json', '${'b'.repeat(64)}'
    );
    INSERT INTO competition_date_index_coverages(
      competition_id, date_jst, fixture_count, fixture_id_digest,
      generated_at, source_r2_key, source_sha256
    ) VALUES (
      1, '2026-08-01', 3, '${'c'.repeat(64)}', '2026-09-08T02:15:09.068Z',
      'migration/date/39/2026-08-01.json', '${'d'.repeat(64)}'
    );
  `);
}

test('v6 preserves date coverage rows and replaces D1-incompatible timestamp GLOB checks', t => {
  const database = openThroughV5();
  t.after(() => database.close());
  seedCoverage(database);

  database.exec(migration);

  assert.deepEqual({ ...database.prepare(`SELECT date_jst, fixture_count, generated_at
    FROM date_index_coverages`).get() }, {
    date_jst: '2026-08-01', fixture_count: 3, generated_at: '2026-09-08T02:15:09.068Z',
  });
  assert.deepEqual({ ...database.prepare(`SELECT competition_id, date_jst, fixture_count, generated_at
    FROM competition_date_index_coverages`).get() }, {
    competition_id: 1, date_jst: '2026-08-01', fixture_count: 3,
    generated_at: '2026-09-08T02:15:09.068Z',
  });

  for (const table of ['date_index_coverages', 'competition_date_index_coverages']) {
    const ddl = database.prepare(`SELECT sql FROM sqlite_schema WHERE type='table' AND name=?`).get(table).sql;
    assert.equal(ddl.includes("generated_at GLOB '[0-9]"), false);
    assert.match(ddl, /strftime\('%Y-%m-%dT%H:%M:%fZ', generated_at\) IS generated_at/);
  }
  assert.throws(() => database.exec(`UPDATE date_index_coverages
    SET generated_at='2026-09-08T02:15:09Z' WHERE date_jst='2026-08-01'`), /CHECK constraint failed/);
  assert.throws(() => database.exec(`UPDATE competition_date_index_coverages
    SET generated_at='not-a-date' WHERE date_jst='2026-08-01'`), /CHECK constraint failed/);
  const foreignKeyTargets = database.prepare(
    'PRAGMA foreign_key_list(competition_date_index_coverages)'
  ).all().map(row => row.table).sort();
  assert.deepEqual(foreignKeyTargets, ['competitions', 'date_index_coverages']);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('v6 recreates the coverage index and every invalidation trigger', t => {
  const database = openThroughV5();
  t.after(() => database.close());
  database.exec(migration);

  const triggers = database.prepare(`SELECT name FROM sqlite_schema
    WHERE type='trigger' AND name LIKE 'date_index_coverage_invalidate_%'
    ORDER BY name`).all().map(row => row.name);
  assert.deepEqual(triggers, [
    'date_index_coverage_invalidate_competition_identity_update',
    'date_index_coverage_invalidate_fixture_delete',
    'date_index_coverage_invalidate_fixture_insert',
    'date_index_coverage_invalidate_fixture_replace',
    'date_index_coverage_invalidate_fixture_scope_update',
    'date_index_coverage_invalidate_season_delete',
    'date_index_coverage_invalidate_season_insert',
    'date_index_coverage_invalidate_season_scope_update',
  ]);
  assert.equal(database.prepare(`SELECT count(*) AS count FROM sqlite_schema
    WHERE type='index' AND name='idx_competition_date_coverages_date'`).get().count, 1);
});
