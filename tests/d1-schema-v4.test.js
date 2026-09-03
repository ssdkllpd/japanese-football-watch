'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const migrationFiles = [
  '0001_d1_core.sql',
  '0002_d1_date_index_coverage.sql',
  '0003_d1_standings_publication.sql',
  '0004_d1_standings_order_and_fixture_date.sql',
];
const migrationSql = migrationFiles.map(file =>
  fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));

function open(count = migrationSql.length) {
  const database = new DatabaseSync(':memory:');
  for (const sql of migrationSql.slice(0, count)) database.exec(sql);
  return database;
}

function seedStandings(database) {
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO competitions(id, canonical_id, source_id, provider_id, name, type)
      VALUES (1, 'af:competition:39', 1, 39, 'Premier League', 'League');
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, status
    ) VALUES (1, 'af:season:39:2026', 1, 1, 2026, '2026', 'active');
    INSERT INTO teams(id, canonical_id, source_id, provider_id, name) VALUES
      (1, 'af:team:1', 1, 1, 'One'),
      (2, 'af:team:2', 1, 2, 'Two'),
      (3, 'af:team:3', 1, 3, 'Three');
    INSERT INTO standings_snapshots(id, competition_season_id, observed_at, checksum)
      VALUES (1, 1, '2026-09-03T00:00:00.000Z', '${'a'.repeat(64)}');
    INSERT INTO standings_groups(snapshot_id, group_id, group_name, group_order) VALUES
      (1, 'group:overall', 'Overall', 0),
      (1, 'group:secondary', 'Secondary', 1);
  `);
}

test('anti-failure: the pre-v4 schema accepts tied served order and orphan group identity', t => {
  const database = open(3);
  t.after(() => database.close());
  seedStandings(database);

  database.exec(`
    INSERT INTO standings_rows(snapshot_id, team_id, group_name, group_id, group_order, row_order)
      VALUES (1, 1, 'Overall', 'group:overall', 0, 0);
    INSERT INTO standings_rows(snapshot_id, team_id, group_name, group_id, group_order, row_order)
      VALUES (1, 2, 'Overall', 'group:overall', 1, 0);
    INSERT INTO standings_rows(snapshot_id, team_id, group_name, group_id, group_order, row_order)
      VALUES (1, 3, 'Missing', 'group:missing', 2, 0);
  `);

  const served = database.prepare(`
    SELECT group_row.group_order, standing.row_order
    FROM standings_rows standing
    LEFT JOIN standings_groups group_row
      ON group_row.snapshot_id = standing.snapshot_id AND group_row.group_id = standing.group_id
    WHERE standing.group_id = 'group:overall'
  `).all().map(row => ({ group_order: row.group_order, row_order: row.row_order }));
  assert.deepEqual(served, [
    { group_order: 0, row_order: 0 },
    { group_order: 0, row_order: 0 },
  ]);
  assert.equal(database.prepare(`SELECT count(*) AS count FROM standings_rows
    WHERE group_id = 'group:missing'`).get().count, 1);
});

test('v4 standings schema makes served order and group identity structural invariants', t => {
  const database = open();
  t.after(() => database.close());
  seedStandings(database);

  database.exec(`INSERT INTO standings_rows(snapshot_id, team_id, group_id, row_order)
    VALUES (1, 1, 'group:overall', 0)`);
  assert.throws(() => database.exec(`INSERT INTO standings_rows(snapshot_id, team_id, group_id, row_order)
    VALUES (1, 2, 'group:overall', 0)`), /UNIQUE constraint failed/);
  assert.throws(() => database.exec(`INSERT INTO standings_rows(snapshot_id, team_id, group_id, row_order)
    VALUES (1, 2, 'group:missing', 1)`), /FOREIGN KEY constraint failed/);
  assert.throws(() => database.exec(`INSERT INTO standings_rows(snapshot_id, team_id, group_id, row_order)
    VALUES (1, 2, NULL, 1)`), /NOT NULL constraint failed/);
  database.exec(`INSERT INTO standings_rows(snapshot_id, team_id, group_id, row_order)
    VALUES (1, 1, 'group:secondary', 0)`);

  const columns = database.prepare('PRAGMA table_info(standings_rows)').all();
  assert.equal(columns.some(column => column.name === 'group_name'), false);
  assert.equal(columns.some(column => column.name === 'group_order'), false);
  assert.deepEqual(columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk)
    .map(column => column.name), ['snapshot_id', 'group_id', 'team_id']);
  assert.match(database.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'standings_rows'`).get().sql, /WITHOUT ROWID/);
  const triggers = database.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'standings_publication_invalidate_row_%'
    ORDER BY name`).all().map(row => row.name);
  assert.deepEqual(triggers, [
    'standings_publication_invalidate_row_delete',
    'standings_publication_invalidate_row_insert',
    'standings_publication_invalidate_row_update',
  ]);
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('v4 rejects fixture dates that are not derived from the UTC kickoff', t => {
  const database = open();
  t.after(() => database.close());
  seedStandings(database);

  const insert = database.prepare(`INSERT INTO fixtures(
    canonical_id, source_id, provider_id, competition_season_id, home_team_id, away_team_id,
    kickoff_utc, date_jst, status_short, ingestion_state
  ) VALUES (?, 1, ?, 1, 1, 2, ?, ?, 'NS', 'scheduled')`);
  assert.throws(() => insert.run('af:fixture:1', 1,
    '2026-09-01T18:00:00.000Z', '2019-01-01'), /Asia\/Tokyo/);
  insert.run('af:fixture:2', 2, '2026-09-01T14:59:59.999Z', '2026-09-01');
  insert.run('af:fixture:3', 3, '2026-09-01T15:00:00.000Z', '2026-09-02');
  assert.throws(() => database.exec(`UPDATE fixtures SET date_jst = '2019-01-01'
    WHERE canonical_id = 'af:fixture:2'`), /Asia\/Tokyo/);
});
