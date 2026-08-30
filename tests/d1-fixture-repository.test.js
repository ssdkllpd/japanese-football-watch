'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { FixtureRepository } = require('../scripts/d1/fixture-repository');
const { createLocalD1 } = require('../scripts/d1/local-d1');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_d1_core.sql'), 'utf8');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(migration);
  database.exec(`
    INSERT INTO provider_sources(id, code, api_version)
    VALUES (1, 'api-football', 'v3');

    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
    VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');

    INSERT INTO competitions(
      id, canonical_id, source_id, provider_id, name, country_code, country_name, type, logo_url, flag_url
    ) VALUES (
      1, 'af:competition:39', 1, 39, 'Premier League', 'GB', 'England', 'League',
      'https://cdn.example/competition.png', 'https://cdn.example/flag.png'
    );

    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label, starts_on, ends_on, status
    ) VALUES (
      1, 'af:season:39:2026', 1, 1, 2026, '2026', '2026-08-01', '2027-05-31', 'active'
    );

    INSERT INTO teams(id, canonical_id, source_id, provider_id, name, code, logo_url) VALUES
      (1, 'af:team:40', 1, 40, 'Home FC', 'HOM', 'https://cdn.example/home.png'),
      (2, 'af:team:50', 1, 50, 'Away FC', 'AWY', 'https://cdn.example/away.png');

    INSERT INTO players(id, canonical_id, source_id, provider_id, display_name, nationality, photo_url)
    VALUES (1, 'af:player:1001', 1, 1001, 'Example Player', 'Japan', 'https://cdn.example/player.png');

    INSERT INTO coaches(id, canonical_id, source_id, provider_id, display_name, photo_url)
    VALUES (1, 'af:coach:501', 1, 501, 'Example Coach', 'https://cdn.example/coach.png');

    INSERT INTO venues(id, canonical_id, source_id, provider_id, name, city)
    VALUES (1, 'af:venue:10', 1, 10, 'Example Stadium', 'London');

    INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id, venue_id,
      home_team_id, away_team_id, kickoff_utc, date_jst, round, referee,
      status_short, status_long, status_elapsed, home_goals, away_goals,
      home_winner, away_winner, ingestion_state
    ) VALUES
      (1, 'af:fixture:9001', 1, 9001, 1, 1, 1, 2, '2026-08-21T20:00:00.000Z', '2026-08-22',
       'Regular Season - 1', 'Ref Example', 'FT', 'Match Finished', 90, 2, 0, 1, 0, 'finalized'),
      (2, 'af:fixture:9002', 1, 9002, 1, 1, 1, 2, '2026-08-28T20:00:00.000Z', '2026-08-29',
       'Regular Season - 2', NULL, 'NS', 'Not Started', NULL, NULL, NULL, NULL, NULL, 'scheduled');

    INSERT INTO fixture_revisions(
      id, fixture_id, revision_no, lifecycle_state, detail_location, content_sha256, created_at, published_at
    ) VALUES
      (1, 1, 1, 'published', 'd1', '${HASH_A}', '2026-08-21T21:00:00.000Z', '2026-08-21T21:01:00.000Z'),
      (2, 1, 2, 'staging', 'd1', '${HASH_B}', '2026-08-21T22:00:00.000Z', NULL);

    UPDATE fixtures SET published_revision = 1 WHERE id = 1;

    INSERT INTO fixture_score_parts(fixture_id, score_kind, home_value, away_value) VALUES
      (1, 'halftime', 1, 0),
      (1, 'fulltime', 2, 0);

    INSERT INTO fixture_events(
      id, fixture_revision_id, event_key, team_id, player_id, elapsed, event_order, type, detail, comments
    ) VALUES
      (1, 1, 'event:published', 1, 1, 12, 0, 'goal', 'Normal Goal', 'Published event'),
      (2, 2, 'event:staging', 2, NULL, 13, 0, 'card', 'Yellow Card', 'Must stay private');

    INSERT INTO fixture_lineups(id, fixture_revision_id, team_id, coach_id, formation) VALUES
      (1, 1, 1, 1, '4-3-3'),
      (2, 2, 1, 1, '3-4-3');

    INSERT INTO fixture_player_records(id, fixture_id, team_id, player_id, kickoff_utc)
    VALUES (1, 1, 1, 1, '2026-08-21T20:00:00.000Z');

    INSERT INTO fixture_player_appearances(
      id, fixture_revision_id, player_record_id, appearance_state, position, minutes, captain
    ) VALUES
      (1, 1, 1, 'started', 'F', 90, 1),
      (2, 2, 1, 'started', 'F', 90, 0);

    INSERT INTO fixture_lineup_entries(lineup_id, player_appearance_id, squad_role, shirt_number, grid)
    VALUES (1, 1, 'starter', 7, '1:1');

    INSERT INTO fixture_player_stats(
      player_appearance_id, minutes, provider_rating, goals, assists, shots, shots_on_target,
      passes, pass_accuracy, yellow_cards
    ) VALUES (1, 90, 8.2, 1, 0, 3, 2, 32, 87.5, 0);

    INSERT INTO fixture_team_stats(
      fixture_revision_id, team_id, shots_total, shots_on_goal, possession_percent,
      passes_total, passes_accurate, fouls, corners, extra_stats_json
    ) VALUES (1, 1, 12, 5, 55.5, 450, 400, 0, 6, '{"offsides":0}');

    INSERT INTO section_states(fixture_revision_id, section_key, presence, observed_at) VALUES
      (1, 'events', 'present', '2026-08-21T21:00:00.000Z'),
      (1, 'lineups', 'present', '2026-08-21T21:00:00.000Z'),
      (1, 'teamStats', 'present', '2026-08-21T21:00:00.000Z'),
      (1, 'playerStats', 'present', '2026-08-21T21:00:00.000Z');

    INSERT INTO field_states(
      fixture_revision_id, fact_kind, fact_key, field_path, presence, issue_flags_json
    ) VALUES
      (1, 'lineup', 'af:team:40', 'formation', 'present', '[]'),
      (1, 'player_stat', 'af:player:1001', 'saves', 'not_applicable', '[]'),
      (1, 'player_stat', 'af:player:1001', 'assists', 'present', '["conflict"]');

    INSERT INTO correction_states(
      correction_key, target_kind, target_canonical_id, field_path, status,
      provider_baseline_json, applied_value_json, reason, source_url, verified_at, reconciled_at
    ) VALUES (
      'fixture-9001-home-score', 'fixture', 'af:fixture:9001', 'fixture.score.fulltime.home', 'active',
      '2', '3', 'Official match report', 'https://example.com/report',
      '2026-08-21T21:30:00.000Z', '2026-08-21T22:00:00.000Z'
    );
  `);
  return database;
}

function trackedBinding(database) {
  const binding = createLocalD1(database);
  let queries = 0;
  return {
    binding: {
      ...binding,
      prepare(sql) {
        queries += 1;
        return binding.prepare(sql);
      },
    },
    queryCount: () => queries,
  };
}

test('local D1 batch rolls back every statement after an integrity error', async t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE sample(value INTEGER NOT NULL CHECK (value > 0))');
  const binding = createLocalD1(database);

  await assert.rejects(binding.batch([
    binding.prepare('INSERT INTO sample(value) VALUES (?1)').bind(1),
    binding.prepare('INSERT INTO sample(value) VALUES (?1)').bind(0),
  ]), /CHECK constraint failed/);

  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sample').get().count, 0);
});

test('unknown fixture returns null after one indexed header lookup', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  const tracked = trackedBinding(database);

  const result = await new FixtureRepository(tracked.binding).resolveFixture('af:fixture:missing');

  assert.equal(result, null);
  assert.equal(tracked.queryCount(), 1);
});

test('compact-only fixture preserves unknown values and reports detail as not fetched', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  const tracked = trackedBinding(database);

  const result = await new FixtureRepository(tracked.binding).resolveFixture('af:fixture:9002');

  assert.equal(result.source, 'd1');
  assert.equal(result.bundle.contractVersion, '2.1.0');
  assert.equal(result.bundle.detailAvailability, 'unavailable');
  assert.deepEqual(result.bundle.fixture.score.goals, { home: null, away: null });
  assert.equal(result.bundle.fixture.teams.home.winner, null);
  assert.equal(result.bundle.fixture.revision, null);
  assert.deepEqual(result.bundle.playerStats, []);
  assert.deepEqual(result.bundle.sectionStates.playerStats, { presence: 'not_fetched' });
  assert.equal(tracked.queryCount(), 2);
});

test('published D1 revision rebuilds the 2.1 DTO and never leaks staging facts', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  const tracked = trackedBinding(database);
  const repository = new FixtureRepository(tracked.binding);

  const result = await repository.resolveFixture('af:fixture:9001');
  const bundle = result.bundle;

  assert.equal(result.source, 'd1');
  assert.equal(bundle.detailAvailability, 'available');
  assert.equal(bundle.fixture.providerId, 9001);
  assert.equal(bundle.fixture.round, 'Regular Season - 1');
  assert.equal(bundle.fixture.referee, 'Ref Example');
  assert.equal(bundle.fixture.status.long, 'Match Finished');
  assert.equal(bundle.fixture.teams.away.winner, false);
  assert.deepEqual(bundle.fixture.score.fulltime, { home: 3, away: 0 });
  assert.equal(bundle.competition.country, 'England');
  assert.equal(bundle.events.length, 1);
  assert.equal(bundle.events[0].id, 'event:published');
  assert.equal(bundle.events[0].comments, 'Published event');
  assert.equal(bundle.lineups.length, 1);
  assert.equal(bundle.lineups[0].formation, '4-3-3');
  assert.deepEqual(bundle.lineups[0].fieldStates.formation, { presence: 'present' });
  assert.equal(bundle.playerStats.length, 1);
  assert.equal(bundle.playerStats[0].captain, true);
  assert.equal(bundle.playerStats[0].values.assists, 0);
  assert.equal(Object.hasOwn(bundle.playerStats[0].values, 'saves'), false);
  assert.deepEqual(bundle.playerStats[0].fieldStates.saves, { presence: 'not_applicable' });
  assert.deepEqual(bundle.playerStats[0].fieldIssues.assists, ['conflict']);
  assert.equal(bundle.teamStats[0].values.fouls, 0);
  assert.equal(bundle.teamStats[0].values.offsides, 0);
  assert.equal(bundle.overrides['fixture.score.fulltime.home'].reason, 'Official match report');
  assert.equal(bundle.overrides['fixture.score.fulltime.home'].status, 'active');
  assert.equal(tracked.queryCount(), 3);
});

test('lineup appearances do not become player statistics when that section was not fetched', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  database.exec(`
    DELETE FROM fixture_player_stats WHERE player_appearance_id = 1;
    UPDATE section_states SET presence = 'not_fetched'
    WHERE fixture_revision_id = 1 AND section_key = 'playerStats';
  `);

  const result = await new FixtureRepository(createLocalD1(database)).resolveFixture('af:fixture:9001');

  assert.equal(result.bundle.lineups[0].startXI.length, 1);
  assert.deepEqual(result.bundle.playerStats, []);
  assert.deepEqual(result.bundle.sectionStates.playerStats, { presence: 'not_fetched' });
});

test('present_empty remains public present with an empty list', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  database.exec(`
    DELETE FROM fixture_team_stats WHERE fixture_revision_id = 1;
    UPDATE section_states SET presence = 'present_empty'
    WHERE fixture_revision_id = 1 AND section_key = 'teamStats';
  `);

  const result = await new FixtureRepository(createLocalD1(database)).resolveFixture('af:fixture:9001');

  assert.deepEqual(result.bundle.teamStats, []);
  assert.deepEqual(result.bundle.sectionStates.teamStats, { presence: 'present' });
});

test('active R2 archive resolves immutable metadata without reading D1 detail state', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  database.exec(`
    INSERT INTO fixture_archives(
      fixture_revision_id, schema_version, r2_key, content_sha256, byte_size,
      status, is_active, archived_at, restore_checked_at
    ) VALUES (
      1, '2.1.0', 'football/v2/fixtures/9001.json', '${HASH_A}', 4096,
      'ready', 1, '2026-08-22T00:00:00.000Z', '2026-08-22T00:01:00.000Z'
    );
    UPDATE fixture_revisions SET detail_location = 'r2' WHERE id = 1;
  `);
  const tracked = trackedBinding(database);

  const result = await new FixtureRepository(tracked.binding).resolveFixture('af:fixture:9001');

  assert.equal(result.source, 'r2');
  assert.equal(result.fixtureId, 'af:fixture:9001');
  assert.deepEqual(result.archive, {
    key: 'football/v2/fixtures/9001.json',
    schemaVersion: '2.1.0',
    contentSha256: HASH_A,
  });
  assert.equal(result.compact.score.fulltime.away, 0);
  assert.equal(tracked.queryCount(), 2);
});

test('review-required correction restores conflict semantics from D1 state', async t => {
  const database = createDatabase();
  t.after(() => database.close());
  database.exec(`
    UPDATE correction_states SET status = 'review_required'
    WHERE correction_key = 'fixture-9001-home-score';
  `);

  const result = await new FixtureRepository(createLocalD1(database))
    .resolveFixture('af:fixture:9001');

  assert.deepEqual(result.bundle.fieldIssues['fixture.score.fulltime.home'], ['conflict']);
  assert.equal(result.bundle.overrides['fixture.score.fulltime.home'].status, 'review_required');
  assert.equal(result.bundle.fixture.score.fulltime.home, 2);
  assert.equal(result.bundle.fixture.ingestionState, 'needs_review');
});
