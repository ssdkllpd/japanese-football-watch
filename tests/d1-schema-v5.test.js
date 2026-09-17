'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('../scripts/d1/migration-inventory');

const root = path.join(__dirname, '..');

function v4Database() {
  const database = new DatabaseSync(':memory:');
  applyMigrations(database, root, { through: '0004_d1_standings_order_and_fixture_date.sql' });
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, type)
      VALUES (1, 'af:competition:39', 1, 39, 'Premier League', 'League');
    INSERT INTO competition_seasons(id, canonical_id, competition_id, product_season_id, provider_season, label, status)
      VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
    INSERT INTO teams(id, canonical_id, source_id, provider_id, name) VALUES
      (1, 'af:team:40', 1, 40, 'Home FC'), (2, 'af:team:50', 1, 50, 'Away FC');
    INSERT INTO players(id, canonical_id, source_id, provider_id, display_name)
      VALUES (1, 'af:player:1001', 1, 1001, 'Player');
    INSERT INTO fixtures(id, canonical_id, source_id, provider_id, competition_season_id,
      home_team_id, away_team_id, kickoff_utc, date_jst, status_short, ingestion_state)
      VALUES (1, 'af:fixture:9001', 1, 9001, 1, 1, 2,
        '2026-08-21T20:00:00.000Z', '2026-08-22', 'FT', 'finalized');
    INSERT INTO fixture_revisions(id, fixture_id, revision_no, lifecycle_state, detail_location,
      content_sha256, created_at, published_at)
      VALUES (1, 1, 1, 'published', 'd1', '${'a'.repeat(64)}',
        '2026-08-21T21:00:00.000Z', '2026-08-21T21:00:00.000Z');
    INSERT INTO fixture_player_records(id, fixture_id, team_id, player_id, kickoff_utc)
      VALUES (1, 1, 1, 1, '2026-08-21T20:00:00.000Z');
    INSERT INTO fixture_player_appearances(id, fixture_revision_id, player_record_id, appearance_state)
      VALUES (1, 1, 1, 'started');
    INSERT INTO fixture_player_stats(player_appearance_id, provider_rating, passes, pass_accuracy)
      VALUES (1, 10, 5, 3);
  `);
  return database;
}

test('0005 renames successful-pass count without retaining the percentage column', t => {
  const database = v4Database();
  t.after(() => database.close());
  database.exec(fs.readFileSync(path.join(root, 'migrations', '0005_d1_player_passes_accurate.sql'), 'utf8'));

  const columns = database.prepare('PRAGMA table_info(fixture_player_stats)').all().map(row => row.name);
  assert.equal(columns.includes('passes_accurate'), true);
  assert.equal(columns.includes('pass_accuracy'), false);
  assert.deepEqual({ ...database.prepare(`SELECT provider_rating, passes, passes_accurate,
    typeof(passes_accurate) AS value_type FROM fixture_player_stats`).get() }, {
    provider_rating: 10, passes: 5, passes_accurate: 3, value_type: 'integer',
  });
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('0005 enforces rating and successful-pass boundaries in SQLite', t => {
  const database = v4Database();
  t.after(() => database.close());
  database.exec(fs.readFileSync(path.join(root, 'migrations', '0005_d1_player_passes_accurate.sql'), 'utf8'));

  assert.throws(() => database.exec('UPDATE fixture_player_stats SET provider_rating = 10.1'), /CHECK constraint/);
  assert.throws(() => database.exec('UPDATE fixture_player_stats SET provider_rating = -0.1'), /CHECK constraint/);
  assert.throws(() => database.exec('UPDATE fixture_player_stats SET passes_accurate = 6'), /CHECK constraint/);
  assert.throws(() => database.exec('UPDATE fixture_player_stats SET passes_accurate = 2.5'), /CHECK constraint/);
});

test('0005 fails closed instead of coercing legacy fractional pass data', t => {
  const database = v4Database();
  t.after(() => database.close());
  database.exec('UPDATE fixture_player_stats SET pass_accuracy = 2.5');
  assert.throws(() => database.exec(
    fs.readFileSync(path.join(root, 'migrations', '0005_d1_player_passes_accurate.sql'), 'utf8'),
  ), /CHECK constraint/);
});
