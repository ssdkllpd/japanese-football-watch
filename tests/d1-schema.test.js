'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const migrationPath = path.join(__dirname, '..', 'migrations', '0001_d1_core.sql');
const migrationSql = fs.readFileSync(migrationPath, 'utf8');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function openDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql);
  return db;
}

function insert(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

function seedCore(db) {
  insert(db, 'INSERT INTO provider_sources(id, code, api_version) VALUES (?, ?, ?)', 1, 'api-football', 'v3');
  insert(db, `INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
    VALUES (?, ?, ?, ?, ?)`, 1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
  insert(db, `INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, country_code, type)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, 1, 'af:competition:39', 1, 39, 'Premier League', 'GB', 'League');
  insert(db, `INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, starts_on, ends_on, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    1, 'af:season:39:2026', 1, 1, 2026, '2026', '2026-08-01', '2027-05-31', 'active');
  insert(db, `INSERT INTO teams(id, canonical_id, source_id, provider_id, name)
    VALUES (?, ?, ?, ?, ?)`, 1, 'af:team:40', 1, 40, 'Home FC');
  insert(db, `INSERT INTO teams(id, canonical_id, source_id, provider_id, name)
    VALUES (?, ?, ?, ?, ?)`, 2, 'af:team:50', 1, 50, 'Away FC');
  insert(db, `INSERT INTO teams(id, canonical_id, source_id, provider_id, name)
    VALUES (?, ?, ?, ?, ?)`, 3, 'af:team:60', 1, 60, 'Other FC');
  insert(db, `INSERT INTO players(id, canonical_id, source_id, provider_id, display_name)
    VALUES (?, ?, ?, ?, ?)`, 1, 'af:player:1942', 1, 1942, 'Tracked Player');
  insert(db, `INSERT INTO players(id, canonical_id, source_id, provider_id, display_name)
    VALUES (?, ?, ?, ?, ?)`, 2, 'af:player:1943', 1, 1943, 'Other Player');
  insert(db, `INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id, home_team_id, away_team_id,
      kickoff_utc, date_jst, status_short, home_goals, away_goals, ingestion_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    1, 'af:fixture:123456', 1, 123456, 1, 1, 2, '2026-08-21T20:00:00.000Z', '2026-08-22', 'FT', 2, 1, 'finalized');
  insert(db, `INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id, home_team_id, away_team_id,
      kickoff_utc, date_jst, status_short, ingestion_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    2, 'af:fixture:123457', 1, 123457, 1, 2, 3, '2026-08-22T20:00:00.000Z', '2026-08-23', 'NS', 'scheduled');
}

function addRevision(db, { id, fixtureId, revisionNo, lifecycle = 'staging', hash = SHA_A }) {
  insert(db, `INSERT INTO fixture_revisions(
      id, fixture_id, revision_no, lifecycle_state, detail_location, content_sha256, created_at, published_at
    ) VALUES (?, ?, ?, ?, 'd1', ?, '2026-08-22T00:00:00.000Z', ?)`,
    id, fixtureId, revisionNo, lifecycle, hash, lifecycle === 'published' ? '2026-08-22T00:01:00.000Z' : null);
}

test('D1 migration creates the reviewed schema without pre-creating Attention tables', () => {
  const db = openDatabase();
  const objects = db.prepare(`SELECT type, name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  const tables = objects.filter(row => row.type === 'table').map(row => row.name);
  const views = objects.filter(row => row.type === 'view').map(row => row.name);

  assert.equal(tables.length, 35);
  assert.ok(tables.includes('fixtures'));
  assert.ok(tables.includes('entity_field_states'));
  assert.ok(tables.includes('fixture_archives'));
  assert.ok(!tables.includes('attention_scores'));
  assert.ok(!tables.includes('match_annotations'));
  assert.ok(!tables.includes('annotation_citations'));
  assert.deepEqual(views, [
    'published_fixture_player_appearances',
    'published_fixture_revisions',
    'published_jfw_rating_results',
  ]);
});

test('provider and canonical identities are unique and date namespaces are checked', () => {
  const db = openDatabase();
  seedCore(db);

  assert.throws(() => insert(db, `INSERT INTO teams(canonical_id, source_id, provider_id, name)
    VALUES (?, ?, ?, ?)`, 'af:team:40', 1, 99, 'Duplicate canonical'), /UNIQUE constraint failed/);
  assert.throws(() => insert(db, `INSERT INTO teams(canonical_id, source_id, provider_id, name)
    VALUES (?, ?, ?, ?)`, 'af:team:99', 1, 40, 'Duplicate provider'), /UNIQUE constraint failed/);
  assert.throws(() => insert(db, `INSERT INTO product_seasons(canonical_id, label, starts_on, ends_on)
    VALUES (?, ?, ?, ?)`, 'af:season:bad', 'bad', '2026-01-01', '2026-12-31'), /CHECK constraint failed/);
});

test('published revision pointer accepts only a published revision of the same fixture', () => {
  const db = openDatabase();
  seedCore(db);
  addRevision(db, { id: 1, fixtureId: 1, revisionNo: 1 });
  addRevision(db, { id: 2, fixtureId: 2, revisionNo: 1, lifecycle: 'published', hash: SHA_B });

  assert.throws(() => insert(db, 'UPDATE fixtures SET published_revision = ? WHERE id = ?', 1, 1), /published_revision/);
  assert.throws(() => insert(db, 'UPDATE fixtures SET published_revision = ? WHERE id = ?', 2, 1), /published_revision/);

  insert(db, `UPDATE fixture_revisions
    SET lifecycle_state = 'published', published_at = '2026-08-22T00:01:00.000Z'
    WHERE id = 1`);
  insert(db, 'UPDATE fixtures SET published_revision = ? WHERE id = ?', 1, 1);
  assert.equal(db.prepare('SELECT published_revision FROM fixtures WHERE id = 1').get().published_revision, 1);
  assert.throws(() => insert(db, `UPDATE fixture_revisions
    SET lifecycle_state = 'superseded' WHERE id = 1`), /active published revision/);
});

test('staging appearances remain invisible until their revision is atomically published', () => {
  const db = openDatabase();
  seedCore(db);
  addRevision(db, { id: 1, fixtureId: 1, revisionNo: 1 });
  insert(db, `INSERT INTO fixture_player_records(id, fixture_id, team_id, player_id, kickoff_utc)
    VALUES (1, 1, 1, 1, '2026-08-21T20:00:00.000Z')`);
  insert(db, `INSERT INTO fixture_player_appearances(
      id, fixture_revision_id, player_record_id, appearance_state, position, minutes
    ) VALUES (1, 1, 1, 'started', 'MF', 90)`);

  assert.equal(db.prepare('SELECT count(*) AS count FROM published_fixture_player_appearances').get().count, 0);
  insert(db, `UPDATE fixture_revisions
    SET lifecycle_state = 'published', published_at = '2026-08-22T00:01:00.000Z'
    WHERE id = 1`);
  insert(db, 'UPDATE fixtures SET published_revision = 1 WHERE id = 1');
  assert.equal(db.prepare('SELECT count(*) AS count FROM published_fixture_player_appearances').get().count, 1);
});

test('player record identity is editable before publication and immutable afterwards', () => {
  const db = openDatabase();
  seedCore(db);
  addRevision(db, { id: 1, fixtureId: 1, revisionNo: 1 });
  insert(db, `INSERT INTO fixture_player_records(id, fixture_id, team_id, player_id, kickoff_utc)
    VALUES (1, 1, 1, 1, '2026-08-21T20:00:00.000Z')`);
  insert(db, 'UPDATE fixture_player_records SET team_id = 2 WHERE id = 1');
  insert(db, `INSERT INTO fixture_player_appearances(id, fixture_revision_id, player_record_id, appearance_state)
    VALUES (1, 1, 1, 'substitute_used')`);
  insert(db, `UPDATE fixture_revisions
    SET lifecycle_state = 'published', published_at = '2026-08-22T00:01:00.000Z'
    WHERE id = 1`);
  insert(db, 'UPDATE fixtures SET published_revision = 1 WHERE id = 1');

  assert.throws(() => insert(db, 'UPDATE fixture_player_records SET team_id = 1 WHERE id = 1'), /immutable/);
  assert.throws(() => insert(db, `INSERT INTO fixture_player_records(fixture_id, team_id, player_id, kickoff_utc)
    VALUES (1, 3, 2, '2026-08-21T20:00:00.000Z')`), /team must belong/);
});

test('appearance, lineup and rating rows cannot cross fixture or team boundaries', () => {
  const db = openDatabase();
  seedCore(db);
  addRevision(db, { id: 1, fixtureId: 1, revisionNo: 1 });
  addRevision(db, { id: 2, fixtureId: 2, revisionNo: 1, hash: SHA_B });
  insert(db, `INSERT INTO fixture_player_records(id, fixture_id, team_id, player_id, kickoff_utc)
    VALUES (1, 1, 1, 1, '2026-08-21T20:00:00.000Z')`);

  assert.throws(() => insert(db, `INSERT INTO fixture_player_appearances(
      id, fixture_revision_id, player_record_id, appearance_state
    ) VALUES (1, 2, 1, 'started')`), /same fixture/);

  insert(db, `INSERT INTO fixture_player_appearances(
    id, fixture_revision_id, player_record_id, appearance_state
  ) VALUES (1, 1, 1, 'started')`);
  insert(db, `INSERT INTO fixture_lineups(id, fixture_revision_id, team_id)
    VALUES (1, 1, 2)`);
  assert.throws(() => insert(db, `INSERT INTO fixture_lineup_entries(
    lineup_id, player_appearance_id, squad_role
  ) VALUES (1, 1, 'starter')`), /revision and team/);

  insert(db, 'UPDATE fixture_lineups SET team_id = 1 WHERE id = 1');
  insert(db, `INSERT INTO fixture_lineup_entries(lineup_id, player_appearance_id, squad_role)
    VALUES (1, 1, 'starter')`);
  assert.throws(() => insert(db, 'UPDATE fixture_lineups SET team_id = 2 WHERE id = 1'), /existing appearance/);
  assert.throws(() => insert(db, `UPDATE fixture_player_appearances
    SET fixture_revision_id = 2 WHERE id = 1`), /same fixture|existing lineup/);
});

test('event ordering treats null extra minute as a real uniqueness key', () => {
  const db = openDatabase();
  seedCore(db);
  addRevision(db, { id: 1, fixtureId: 1, revisionNo: 1 });
  insert(db, `INSERT INTO fixture_events(
    fixture_revision_id, event_key, elapsed, extra_minute, event_order, type
  ) VALUES (1, 'event-1', 10, NULL, 1, 'goal')`);
  assert.throws(() => insert(db, `INSERT INTO fixture_events(
    fixture_revision_id, event_key, elapsed, extra_minute, event_order, type
  ) VALUES (1, 'event-2', 10, NULL, 1, 'goal')`), /UNIQUE constraint failed/);
});

test('missing-state, tracking XOR and archive active-pointer checks fail closed', () => {
  const db = openDatabase();
  seedCore(db);
  addRevision(db, { id: 1, fixtureId: 1, revisionNo: 1, lifecycle: 'published' });
  insert(db, `INSERT INTO section_states(
    fixture_revision_id, section_key, presence, observed_at
  ) VALUES (1, 'events', 'present_empty', '2026-08-22T00:01:00.000Z')`);
  assert.throws(() => insert(db, `INSERT INTO section_states(
    fixture_revision_id, section_key, presence, observed_at
  ) VALUES (1, 'lineups', 'provider_unavailable', '2026-08-22T00:01:00.000Z')`), /CHECK constraint failed/);

  insert(db, `INSERT INTO tracked_players(jfw_player_id, crosswalk_state, tracking_status)
    VALUES ('jp:test', 'unresolved', 'active')`);
  assert.throws(() => insert(db, `INSERT INTO tracking_periods(
    jfw_player_id, valid_from, valid_to, tracking_status, change_type, verification
  ) VALUES ('jp:test', '2026-08-01', '9999-12-31', 'active', 'registration', 'verified')`), /CHECK constraint failed/);
  assert.throws(() => insert(db, `INSERT INTO tracked_players(
    jfw_player_id, crosswalk_state, tracking_status
  ) VALUES ('jp:invalid-status', 'unresolved', 'tracked')`), /CHECK constraint failed/);

  insert(db, `INSERT INTO fixture_archives(
    fixture_revision_id, schema_version, r2_key, content_sha256, byte_size, status, is_active, archived_at
  ) VALUES (1, '2.1.0', 'archive/a', ?, 100, 'ready', 1, '2026-08-22T00:01:00.000Z')`, SHA_A);
  assert.throws(() => insert(db, `INSERT INTO fixture_archives(
    fixture_revision_id, schema_version, r2_key, content_sha256, byte_size, status, is_active, archived_at
  ) VALUES (1, '2.2.0', 'archive/b', ?, 100, 'ready', 1, '2026-08-22T00:01:00.000Z')`, SHA_B), /UNIQUE constraint failed/);
  assert.throws(() => insert(db, `INSERT INTO fixture_archives(
    fixture_revision_id, schema_version, r2_key, content_sha256, byte_size, status, is_active, archived_at
  ) VALUES (1, '2.3.0', 'archive/c', ?, 100, 'verifying', 1, '2026-08-22T00:01:00.000Z')`, 'c'.repeat(64)), /CHECK constraint failed/);
});

test('nullable aggregate scope columns still form one deterministic identity', () => {
  const db = openDatabase();
  seedCore(db);
  insert(db, `INSERT INTO tracked_players(jfw_player_id, player_id, crosswalk_state, tracking_status)
    VALUES ('jp:test', 1, 'resolved', 'active')`);
  insert(db, `INSERT INTO tracked_player_aggregates(
    jfw_player_id, product_season_id, aggregate_scope, stats_json, source_hash, rebuilt_at
  ) VALUES ('jp:test', 1, 'season', '{}', ?, '2026-08-22T00:00:00.000Z')`, SHA_A);
  assert.throws(() => insert(db, `INSERT INTO tracked_player_aggregates(
    jfw_player_id, product_season_id, aggregate_scope, stats_json, source_hash, rebuilt_at
  ) VALUES ('jp:test', 1, 'season', '{}', ?, '2026-08-22T00:01:00.000Z')`, SHA_B), /UNIQUE constraint failed/);
});

test('fixture player stats expose every normalized v2 values field as a typed column', () => {
  const db = openDatabase();
  const columns = new Set(db.prepare('PRAGMA table_info(fixture_player_stats)').all().map(row => row.name));
  const expected = [
    'minutes', 'provider_rating', 'goals', 'assists', 'goals_conceded', 'saves', 'shots',
    'shots_on_target', 'passes', 'key_passes', 'pass_accuracy', 'tackles', 'blocks',
    'interceptions', 'duels', 'duels_won', 'dribble_attempts', 'dribbles', 'dribbled_past',
    'fouls_drawn', 'fouls_committed', 'yellow_cards', 'red_cards', 'penalties_won',
    'penalties_conceded', 'penalties_scored', 'penalties_missed', 'penalties_saved',
  ];
  for (const name of expected) assert.ok(columns.has(name), `missing typed stat column: ${name}`);
});

test('D1 columns preserve every existing fixture-bundle field required for DTO parity', () => {
  const db = openDatabase();
  const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  const expected = {
    competitions: ['country_name', 'logo_url', 'flag_url'],
    fixtures: [
      'source_id', 'provider_id', 'round', 'referee', 'status_long',
      'home_winner', 'away_winner',
    ],
    fixture_events: ['comments'],
    fixture_player_appearances: ['captain'],
  };
  for (const [table, names] of Object.entries(expected)) {
    const actual = columns(table);
    for (const name of names) assert.ok(actual.has(name), `${table}.${name} is required for DTO parity`);
  }
});

test('representative public queries use the reviewed indexes', () => {
  const db = openDatabase();
  const plans = [
    db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM fixtures
      WHERE date_jst = ? ORDER BY kickoff_utc`).all('2026-08-22'),
    db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM fixture_events
      WHERE fixture_revision_id = ? ORDER BY elapsed, extra_minute, event_order`).all(1),
    db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM fixture_player_records
      WHERE player_id = ? ORDER BY kickoff_utc DESC`).all(1),
    db.prepare(`EXPLAIN QUERY PLAN SELECT correction_key FROM correction_states
      WHERE target_canonical_id = ?`).all('af:fixture:1'),
  ].flat().map(row => row.detail).join('\n');

  assert.match(plans, /idx_fixtures_date_kickoff/);
  assert.match(plans, /idx_fixture_events_timeline|ux_fixture_events_order/);
  assert.match(plans, /idx_fixture_player_records_history/);
  assert.match(plans, /idx_correction_states_target/);
  assert.doesNotMatch(plans, /SCAN fixtures/);
  assert.doesNotMatch(plans, /SCAN fixture_events/);
  assert.doesNotMatch(plans, /SCAN fixture_player_records/);
  assert.doesNotMatch(plans, /SCAN correction_states/);
});
