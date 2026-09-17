'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createLocalD1 } = require('../scripts/d1/local-d1');
const { applyMigrations } = require('../scripts/d1/migration-inventory');

const root = path.join(__dirname, '..');

function database() {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, root);
  db.exec(`
    INSERT INTO provider_sources(id, code, api_version) VALUES (1, 'api-football', 'v3');
    INSERT INTO product_seasons(id, canonical_id, label, starts_on, ends_on)
      VALUES (1, 'jfw:season:2026-27', '2026-27', '2026-07-01', '2027-06-30');
    INSERT INTO competitions(
      id, canonical_id, source_id, provider_id, name, country_name, type, logo_url, flag_url
    ) VALUES (
      1, 'af:competition:39', 1, 39, 'Premier League', 'England', 'League',
      'https://media.test/leagues/39.png', 'https://media.test/flags/gb.svg'
    );
    INSERT INTO competition_seasons(
      id, canonical_id, competition_id, product_season_id, provider_season, label,
      starts_on, ends_on, status
    ) VALUES (
      1, 'af:season:39:2026', 1, 1, 2026, '2026', '2026-08-01', '2027-05-31', 'active'
    );
    INSERT INTO teams(id, canonical_id, source_id, provider_id, name, logo_url) VALUES
      (1, 'af:team:40', 1, 40, 'Home FC', 'https://media.test/teams/40.png'),
      (2, 'af:team:50', 1, 50, 'Away FC', 'https://media.test/teams/50.png');
    INSERT INTO competition_season_teams(competition_season_id, team_id) VALUES (1, 1), (1, 2);
    INSERT INTO fixtures(
      id, canonical_id, source_id, provider_id, competition_season_id, home_team_id,
      away_team_id, kickoff_utc, date_jst, status_short, status_long, ingestion_state
    ) VALUES (
      1, 'af:fixture:9001', 1, 9001, 1, 1, 2,
      '2026-08-21T20:00:00.000Z', '2026-08-22', 'FT', 'Match Finished', 'finalized'
    );
    INSERT INTO fixture_revisions(
      id, fixture_id, revision_no, lifecycle_state, detail_location, content_sha256,
      created_at, published_at
    ) VALUES (
      1, 1, 1, 'published', 'd1',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '2026-08-22T00:00:00.000Z', '2026-08-22T00:01:00.000Z'
    );
    UPDATE fixtures SET published_revision = 1 WHERE id = 1;
    INSERT INTO section_states(fixture_revision_id, section_key, presence, observed_at) VALUES
      (1, 'lineups', 'present', '2026-08-22T00:00:00.000Z'),
      (1, 'events', 'provider_missing', '2026-08-22T00:00:00.000Z'),
      (1, 'teamStats', 'present_empty', '2026-08-22T00:00:00.000Z'),
      (1, 'playerStats', 'not_fetched', '2026-08-22T00:00:00.000Z');
    INSERT INTO players(
      id, canonical_id, source_id, provider_id, display_name, nationality, photo_url
    ) VALUES (
      1, 'af:player:7', 1, 7, 'Test Player', 'Japan', 'https://media.test/players/7.png'
    );
    INSERT INTO fixture_player_records(
      id, fixture_id, team_id, player_id, kickoff_utc
    ) VALUES (1, 1, 1, 1, '2026-08-21T20:00:00.000Z');
    INSERT INTO fixture_player_appearances(
      id, fixture_revision_id, player_record_id, appearance_state, position, minutes
    ) VALUES (1, 1, 1, 'started', 'F', 90);
    INSERT INTO fixture_player_stats(
      player_appearance_id, minutes, provider_rating, goals, assists,
      yellow_cards, red_cards
    ) VALUES (1, 90, 7.4, 0, NULL, 1, 0);
  `);
  return db;
}

function cache() {
  const rows = new Map();
  return {
    async match(request) { return rows.get(request.url)?.clone() || null; },
    async put(request, response) { rows.set(request.url, response.clone()); },
  };
}

test('competition directory is stable without relying on the selected date feed', async t => {
  const worker = await import('../worker/index.mjs');
  const db = database();
  t.after(() => db.close());

  const result = await worker.buildD1CompetitionDirectory({ FOOTBALL_DB: createLocalD1(db) });
  assert.equal(result.competitions.length, 1);
  assert.equal(result.competitions[0].id, 'af:competition:39');
  assert.equal(result.competitions[0].logo, 'https://media.test/leagues/39.png');
  assert.equal(result.competitions[0].seasons[0].id, 'af:season:39:2026');
  assert.equal(result.competitions[0].seasons[0].summary.fixtureCount, 1);
});

test('season aggregation preserves provider missing, not fetched, zero and null separately', async t => {
  const worker = await import('../worker/index.mjs');
  const db = database();
  t.after(() => db.close());

  const result = await worker.buildD1CompetitionSeason(
    { FOOTBALL_DB: createLocalD1(db) },
    'af:competition:39',
    'af:season:39:2026',
  );
  assert.equal(result.summary.publishedDetailCount, 1);
  assert.deepEqual(result.detailSections.events, {
    presence: 'provider_missing', total: 1, present: 0, presentEmpty: 0,
    notFetched: 0, providerMissing: 1, notApplicable: 0,
  });
  assert.equal(result.detailSections.playerStats.presence, 'not_fetched');
  assert.equal(result.playerStats.rows[0].goals.value, 0);
  assert.equal(result.playerStats.rows[0].goals.presence, 'present');
  assert.equal(result.playerStats.rows[0].assists.value, null);
  assert.equal(result.playerStats.rows[0].assists.presence, 'not_fetched');
});

test('an empty player aggregate follows the stored section state instead of guessing provider missing', async t => {
  const worker = await import('../worker/index.mjs');
  const db = database();
  t.after(() => db.close());
  db.exec('DELETE FROM fixture_player_appearances');

  const notFetched = await worker.buildD1CompetitionSeason(
    { FOOTBALL_DB: createLocalD1(db) }, 'af:competition:39', 'af:season:39:2026',
  );
  assert.equal(notFetched.playerStats.presence, 'not_fetched');

  db.exec(`UPDATE section_states SET presence = 'provider_missing'
    WHERE fixture_revision_id = 1 AND section_key = 'playerStats'`);
  const providerMissing = await worker.buildD1CompetitionSeason(
    { FOOTBALL_DB: createLocalD1(db) }, 'af:competition:39', 'af:season:39:2026',
  );
  assert.equal(providerMissing.playerStats.presence, 'provider_missing');
});

test('public competition endpoints serve D1 identity and reject unknown seasons', async t => {
  const worker = await import('../worker/index.mjs');
  const db = database();
  t.after(() => db.close());
  const env = {
    APP_ORIGINS: 'https://example.github.io',
    FOOTBALL_DB: createLocalD1(db),
    RESPONSE_CACHE: cache(),
  };
  const request = pathName => new Request(`https://worker.example${pathName}`, {
    headers: { origin: 'https://example.github.io' },
  });

  const directory = await worker.default.fetch(request('/api/v2/competitions'), env, {});
  assert.equal(directory.status, 200);
  assert.equal(directory.headers.get('x-jfw-data-source'), 'd1');
  assert.equal((await directory.json()).competitions[0].name, 'Premier League');

  const season = await worker.default.fetch(request(
    '/api/v2/competitions/af%3Acompetition%3A39/seasons/af%3Aseason%3A39%3A2026',
  ), env, {});
  assert.equal(season.status, 200);
  assert.equal((await season.json()).playerStats.rows[0].player.name, 'Test Player');

  const missing = await worker.default.fetch(request(
    '/api/v2/competitions/af%3Acompetition%3A39/seasons/af%3Aseason%3A39%3A2025',
  ), env, {});
  assert.equal(missing.status, 404);
});
