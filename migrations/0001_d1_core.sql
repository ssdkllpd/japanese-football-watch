PRAGMA foreign_keys = ON;

CREATE TABLE provider_sources (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  api_version TEXT NOT NULL
);

CREATE TABLE product_seasons (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE CHECK (canonical_id LIKE 'jfw:season:%'),
  label TEXT NOT NULL,
  starts_on TEXT NOT NULL CHECK (starts_on GLOB '????-??-??'),
  ends_on TEXT NOT NULL CHECK (ends_on GLOB '????-??-??'),
  CHECK (starts_on <= ends_on)
);

CREATE TABLE competitions (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE CHECK (canonical_id LIKE 'af:competition:%'),
  source_id INTEGER NOT NULL REFERENCES provider_sources(id),
  provider_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  country_code TEXT,
  country_name TEXT,
  type TEXT NOT NULL CHECK (type IN ('League', 'Cup')),
  logo_url TEXT,
  flag_url TEXT,
  UNIQUE (source_id, provider_id)
);

CREATE TABLE competition_seasons (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE CHECK (canonical_id LIKE 'af:season:%'),
  competition_id INTEGER NOT NULL REFERENCES competitions(id),
  product_season_id INTEGER REFERENCES product_seasons(id),
  provider_season INTEGER NOT NULL,
  label TEXT NOT NULL,
  starts_on TEXT CHECK (starts_on IS NULL OR starts_on GLOB '????-??-??'),
  ends_on TEXT CHECK (ends_on IS NULL OR ends_on GLOB '????-??-??'),
  finalized_on TEXT CHECK (finalized_on IS NULL OR finalized_on GLOB '????-??-??'),
  status TEXT NOT NULL,
  UNIQUE (competition_id, provider_season),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on)
);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE CHECK (canonical_id LIKE 'af:team:%'),
  source_id INTEGER NOT NULL REFERENCES provider_sources(id),
  provider_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  logo_url TEXT,
  UNIQUE (source_id, provider_id)
);

CREATE TABLE players (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE CHECK (canonical_id LIKE 'af:player:%'),
  source_id INTEGER NOT NULL REFERENCES provider_sources(id),
  provider_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  nationality TEXT,
  birth_date TEXT CHECK (birth_date IS NULL OR birth_date GLOB '????-??-??'),
  photo_url TEXT,
  UNIQUE (source_id, provider_id)
);

CREATE TABLE coaches (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE CHECK (canonical_id LIKE 'af:coach:%'),
  source_id INTEGER NOT NULL REFERENCES provider_sources(id),
  provider_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  photo_url TEXT,
  UNIQUE (source_id, provider_id)
);

CREATE TABLE venues (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE CHECK (canonical_id LIKE 'af:venue:%'),
  source_id INTEGER NOT NULL REFERENCES provider_sources(id),
  provider_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  city TEXT,
  UNIQUE (source_id, provider_id)
);

CREATE TABLE competition_season_teams (
  competition_season_id INTEGER NOT NULL REFERENCES competition_seasons(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  PRIMARY KEY (competition_season_id, team_id)
) WITHOUT ROWID;

CREATE TABLE fixtures (
  id INTEGER PRIMARY KEY,
  canonical_id TEXT NOT NULL UNIQUE CHECK (canonical_id LIKE 'af:fixture:%'),
  source_id INTEGER NOT NULL REFERENCES provider_sources(id),
  provider_id INTEGER NOT NULL,
  competition_season_id INTEGER NOT NULL REFERENCES competition_seasons(id),
  venue_id INTEGER REFERENCES venues(id),
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  kickoff_utc TEXT NOT NULL CHECK (kickoff_utc GLOB '????-??-??T??:??:??*Z'),
  date_jst TEXT NOT NULL CHECK (date_jst GLOB '????-??-??'),
  round TEXT,
  referee TEXT,
  status_short TEXT NOT NULL,
  status_long TEXT,
  status_elapsed INTEGER CHECK (status_elapsed IS NULL OR status_elapsed >= 0),
  home_goals INTEGER CHECK (home_goals IS NULL OR home_goals >= 0),
  away_goals INTEGER CHECK (away_goals IS NULL OR away_goals >= 0),
  home_winner INTEGER CHECK (home_winner IS NULL OR home_winner IN (0, 1)),
  away_winner INTEGER CHECK (away_winner IS NULL OR away_winner IN (0, 1)),
  ingestion_state TEXT NOT NULL CHECK (ingestion_state IN ('scheduled', 'live', 'provisional_final', 'finalized', 'needs_review')),
  published_revision INTEGER REFERENCES fixture_revisions(id) ON DELETE SET NULL,
  UNIQUE (source_id, provider_id),
  CHECK (home_team_id <> away_team_id)
);

CREATE TABLE fixture_revisions (
  id INTEGER PRIMARY KEY,
  fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('staging', 'published', 'superseded')),
  detail_location TEXT NOT NULL CHECK (detail_location IN ('d1', 'r2')),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  published_at TEXT CHECK (published_at IS NULL OR published_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE (fixture_id, revision_no),
  UNIQUE (id, fixture_id)
);

CREATE TABLE fixture_score_parts (
  fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  score_kind TEXT NOT NULL,
  home_value INTEGER CHECK (home_value IS NULL OR home_value >= 0),
  away_value INTEGER CHECK (away_value IS NULL OR away_value >= 0),
  PRIMARY KEY (fixture_id, score_kind)
) WITHOUT ROWID;

CREATE TABLE fixture_events (
  id INTEGER PRIMARY KEY,
  fixture_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id),
  player_id INTEGER REFERENCES players(id),
  related_player_id INTEGER REFERENCES players(id),
  elapsed INTEGER CHECK (elapsed IS NULL OR elapsed >= 0),
  extra_minute INTEGER CHECK (extra_minute IS NULL OR extra_minute >= 0),
  event_order INTEGER NOT NULL CHECK (event_order >= 0),
  type TEXT NOT NULL CHECK (type IN ('goal', 'card', 'substitution', 'var', 'other')),
  detail TEXT,
  comments TEXT,
  UNIQUE (fixture_revision_id, event_key)
);

CREATE TABLE fixture_lineups (
  id INTEGER PRIMARY KEY,
  fixture_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  coach_id INTEGER REFERENCES coaches(id),
  formation TEXT,
  UNIQUE (fixture_revision_id, team_id),
  UNIQUE (id, fixture_revision_id, team_id)
);

CREATE TABLE fixture_player_records (
  id INTEGER PRIMARY KEY,
  fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  kickoff_utc TEXT NOT NULL CHECK (kickoff_utc GLOB '????-??-??T??:??:??*Z'),
  UNIQUE (fixture_id, player_id),
  UNIQUE (id, fixture_id, team_id)
);

CREATE TABLE fixture_player_appearances (
  id INTEGER PRIMARY KEY,
  fixture_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(id) ON DELETE CASCADE,
  player_record_id INTEGER NOT NULL REFERENCES fixture_player_records(id),
  appearance_state TEXT NOT NULL CHECK (appearance_state IN ('started', 'substitute_used', 'bench_unused', 'absent_confirmed', 'unknown')),
  position TEXT,
  minutes INTEGER CHECK (minutes IS NULL OR minutes >= 0),
  captain INTEGER CHECK (captain IS NULL OR captain IN (0, 1)),
  UNIQUE (fixture_revision_id, player_record_id),
  UNIQUE (id, fixture_revision_id, player_record_id)
);

CREATE TABLE fixture_lineup_entries (
  lineup_id INTEGER NOT NULL REFERENCES fixture_lineups(id) ON DELETE CASCADE,
  player_appearance_id INTEGER NOT NULL REFERENCES fixture_player_appearances(id) ON DELETE CASCADE,
  squad_role TEXT NOT NULL CHECK (squad_role IN ('starter', 'substitute')),
  entry_order INTEGER NOT NULL CHECK (entry_order >= 0),
  shirt_number INTEGER CHECK (shirt_number IS NULL OR shirt_number > 0),
  grid TEXT,
  PRIMARY KEY (lineup_id, player_appearance_id),
  UNIQUE (player_appearance_id),
  UNIQUE (lineup_id, squad_role, entry_order)
) WITHOUT ROWID;

CREATE TABLE fixture_player_stats (
  player_appearance_id INTEGER PRIMARY KEY REFERENCES fixture_player_appearances(id) ON DELETE CASCADE,
  minutes INTEGER CHECK (minutes IS NULL OR minutes >= 0),
  provider_rating REAL CHECK (provider_rating IS NULL OR provider_rating >= 0),
  goals INTEGER CHECK (goals IS NULL OR goals >= 0),
  assists INTEGER CHECK (assists IS NULL OR assists >= 0),
  goals_conceded INTEGER CHECK (goals_conceded IS NULL OR goals_conceded >= 0),
  saves INTEGER CHECK (saves IS NULL OR saves >= 0),
  shots INTEGER CHECK (shots IS NULL OR shots >= 0),
  shots_on_target INTEGER CHECK (shots_on_target IS NULL OR shots_on_target >= 0),
  passes INTEGER CHECK (passes IS NULL OR passes >= 0),
  key_passes INTEGER CHECK (key_passes IS NULL OR key_passes >= 0),
  pass_accuracy REAL CHECK (pass_accuracy IS NULL OR (pass_accuracy >= 0 AND pass_accuracy <= 100)),
  tackles INTEGER CHECK (tackles IS NULL OR tackles >= 0),
  blocks INTEGER CHECK (blocks IS NULL OR blocks >= 0),
  interceptions INTEGER CHECK (interceptions IS NULL OR interceptions >= 0),
  duels INTEGER CHECK (duels IS NULL OR duels >= 0),
  duels_won INTEGER CHECK (duels_won IS NULL OR duels_won >= 0),
  dribble_attempts INTEGER CHECK (dribble_attempts IS NULL OR dribble_attempts >= 0),
  dribbles INTEGER CHECK (dribbles IS NULL OR dribbles >= 0),
  dribbled_past INTEGER CHECK (dribbled_past IS NULL OR dribbled_past >= 0),
  fouls_drawn INTEGER CHECK (fouls_drawn IS NULL OR fouls_drawn >= 0),
  fouls_committed INTEGER CHECK (fouls_committed IS NULL OR fouls_committed >= 0),
  yellow_cards INTEGER CHECK (yellow_cards IS NULL OR yellow_cards >= 0),
  red_cards INTEGER CHECK (red_cards IS NULL OR red_cards >= 0),
  penalties_won INTEGER CHECK (penalties_won IS NULL OR penalties_won >= 0),
  penalties_conceded INTEGER CHECK (penalties_conceded IS NULL OR penalties_conceded >= 0),
  penalties_scored INTEGER CHECK (penalties_scored IS NULL OR penalties_scored >= 0),
  penalties_missed INTEGER CHECK (penalties_missed IS NULL OR penalties_missed >= 0),
  penalties_saved INTEGER CHECK (penalties_saved IS NULL OR penalties_saved >= 0),
  extra_stats_json TEXT CHECK (extra_stats_json IS NULL OR json_valid(extra_stats_json))
);

CREATE TABLE fixture_team_stats (
  fixture_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  shots_total INTEGER CHECK (shots_total IS NULL OR shots_total >= 0),
  shots_on_goal INTEGER CHECK (shots_on_goal IS NULL OR shots_on_goal >= 0),
  possession_percent REAL CHECK (possession_percent IS NULL OR (possession_percent >= 0 AND possession_percent <= 100)),
  passes_total INTEGER CHECK (passes_total IS NULL OR passes_total >= 0),
  passes_accurate INTEGER CHECK (passes_accurate IS NULL OR passes_accurate >= 0),
  fouls INTEGER CHECK (fouls IS NULL OR fouls >= 0),
  corners INTEGER CHECK (corners IS NULL OR corners >= 0),
  extra_stats_json TEXT CHECK (extra_stats_json IS NULL OR json_valid(extra_stats_json)),
  PRIMARY KEY (fixture_revision_id, team_id)
) WITHOUT ROWID;

CREATE TABLE player_team_memberships (
  id INTEGER PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  valid_from TEXT NOT NULL CHECK (valid_from GLOB '????-??-??'),
  valid_to TEXT NOT NULL DEFAULT '9999-12-31' CHECK (valid_to GLOB '????-??-??'),
  verification TEXT NOT NULL CHECK (verification IN ('verified', 'provider', 'legacy_unverified')),
  CHECK (valid_from <= valid_to),
  UNIQUE (player_id, team_id, valid_from)
);

CREATE TABLE standings_snapshots (
  id INTEGER PRIMARY KEY,
  competition_season_id INTEGER NOT NULL REFERENCES competition_seasons(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??*Z'),
  is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  UNIQUE (competition_season_id, observed_at)
);

CREATE TABLE standings_rows (
  snapshot_id INTEGER NOT NULL REFERENCES standings_snapshots(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  group_name TEXT NOT NULL DEFAULT '',
  rank INTEGER CHECK (rank IS NULL OR rank > 0),
  points INTEGER,
  played INTEGER CHECK (played IS NULL OR played >= 0),
  goal_difference INTEGER,
  form TEXT,
  PRIMARY KEY (snapshot_id, team_id, group_name)
) WITHOUT ROWID;

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY,
  run_type TEXT NOT NULL,
  started_at TEXT NOT NULL CHECK (started_at GLOB '????-??-??T??:??:??*Z'),
  finished_at TEXT CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??*Z'),
  status TEXT NOT NULL,
  requests_used INTEGER NOT NULL DEFAULT 0 CHECK (requests_used >= 0),
  code_revision TEXT NOT NULL
);

CREATE TABLE raw_snapshots (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES provider_sources(id),
  r2_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  fetched_at TEXT NOT NULL CHECK (fetched_at GLOB '????-??-??T??:??:??*Z'),
  retention_class TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0)
);

CREATE TABLE record_sources (
  id INTEGER PRIMARY KEY,
  sync_run_id INTEGER REFERENCES sync_runs(id),
  raw_snapshot_id INTEGER REFERENCES raw_snapshots(id),
  fact_kind TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  observed_at TEXT NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??*Z'),
  verification TEXT NOT NULL CHECK (verification IN ('verified', 'provider', 'legacy_unverified')),
  issue_flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(issue_flags_json)),
  UNIQUE (fact_kind, fact_key, observed_at, raw_snapshot_id)
);

CREATE TABLE section_states (
  fixture_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  presence TEXT NOT NULL CHECK (presence IN ('present', 'present_empty', 'not_fetched', 'provider_missing', 'not_applicable')),
  source_record_id INTEGER REFERENCES record_sources(id),
  observed_at TEXT NOT NULL CHECK (observed_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (fixture_revision_id, section_key)
) WITHOUT ROWID;

CREATE TABLE field_states (
  fixture_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(id) ON DELETE CASCADE,
  fact_kind TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  field_path TEXT NOT NULL,
  presence TEXT NOT NULL CHECK (presence IN ('present', 'not_fetched', 'provider_missing', 'not_applicable')),
  source_record_id INTEGER REFERENCES record_sources(id),
  issue_flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(issue_flags_json)),
  PRIMARY KEY (fixture_revision_id, fact_kind, fact_key, field_path)
) WITHOUT ROWID;

CREATE TABLE entity_field_states (
  fact_kind TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  field_path TEXT NOT NULL,
  presence TEXT NOT NULL CHECK (presence IN ('present', 'not_fetched', 'provider_missing', 'not_applicable')),
  source_record_id INTEGER REFERENCES record_sources(id),
  issue_flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(issue_flags_json)),
  PRIMARY KEY (fact_kind, fact_key, field_path)
) WITHOUT ROWID;

CREATE TABLE fixture_archives (
  fixture_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  status TEXT NOT NULL CHECK (status IN ('verifying', 'ready', 'superseded', 'quarantined')),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  archived_at TEXT NOT NULL CHECK (archived_at GLOB '????-??-??T??:??:??*Z'),
  restore_checked_at TEXT CHECK (restore_checked_at IS NULL OR restore_checked_at GLOB '????-??-??T??:??:??*Z'),
  PRIMARY KEY (fixture_revision_id, schema_version),
  CHECK (is_active = 0 OR status = 'ready')
) WITHOUT ROWID;

CREATE TABLE tracked_players (
  jfw_player_id TEXT PRIMARY KEY,
  player_id INTEGER UNIQUE REFERENCES players(id),
  crosswalk_state TEXT NOT NULL CHECK (crosswalk_state IN ('resolved', 'unresolved', 'ambiguous')),
  crosswalk_method TEXT,
  crosswalk_sync_run_id INTEGER REFERENCES sync_runs(id),
  tracking_status TEXT NOT NULL CHECK (tracking_status IN ('active', 'out_of_scope', 'unattached')),
  tracking_started_on TEXT CHECK (tracking_started_on IS NULL OR tracking_started_on GLOB '????-??-??'),
  tracking_ended_on TEXT CHECK (tracking_ended_on IS NULL OR tracking_ended_on GLOB '????-??-??'),
  CHECK ((crosswalk_state = 'resolved' AND player_id IS NOT NULL) OR (crosswalk_state <> 'resolved' AND player_id IS NULL)),
  CHECK (tracking_started_on IS NULL OR tracking_ended_on IS NULL OR tracking_started_on <= tracking_ended_on)
);

CREATE TABLE legacy_tracking_memberships (
  id INTEGER PRIMARY KEY,
  jfw_player_id TEXT NOT NULL REFERENCES tracked_players(jfw_player_id),
  legacy_team_label TEXT NOT NULL,
  legacy_competition_label TEXT NOT NULL,
  valid_from TEXT NOT NULL CHECK (valid_from GLOB '????-??-??'),
  valid_to TEXT NOT NULL DEFAULT '9999-12-31' CHECK (valid_to GLOB '????-??-??'),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  CHECK (valid_from <= valid_to),
  UNIQUE (jfw_player_id, legacy_team_label, legacy_competition_label, valid_from)
);

CREATE TABLE tracking_periods (
  id INTEGER PRIMARY KEY,
  jfw_player_id TEXT NOT NULL REFERENCES tracked_players(jfw_player_id),
  core_membership_id INTEGER REFERENCES player_team_memberships(id),
  legacy_membership_id INTEGER REFERENCES legacy_tracking_memberships(id),
  competition_season_id INTEGER REFERENCES competition_seasons(id),
  valid_from TEXT NOT NULL CHECK (valid_from GLOB '????-??-??'),
  valid_to TEXT NOT NULL DEFAULT '9999-12-31' CHECK (valid_to GLOB '????-??-??'),
  tracking_status TEXT NOT NULL CHECK (tracking_status IN ('active', 'inactive', 'out_of_scope', 'unattached')),
  change_type TEXT NOT NULL,
  verification TEXT NOT NULL CHECK (verification IN ('verified', 'provider', 'legacy_unverified')),
  CHECK ((core_membership_id IS NULL) <> (legacy_membership_id IS NULL)),
  CHECK (valid_from <= valid_to)
);

CREATE TABLE jfw_rating_results (
  player_record_id INTEGER NOT NULL REFERENCES fixture_player_records(id) ON DELETE CASCADE,
  jfw_player_id TEXT NOT NULL REFERENCES tracked_players(jfw_player_id),
  rating_version TEXT NOT NULL,
  rated_fixture_revision_id INTEGER NOT NULL REFERENCES fixture_revisions(id) ON DELETE CASCADE,
  rating REAL,
  rating_state TEXT NOT NULL CHECK (rating_state IN ('computed', 'missing', 'not_applicable', 'conflict')),
  inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  PRIMARY KEY (player_record_id, rating_version),
  CHECK ((rating_state = 'computed' AND rating IS NOT NULL) OR (rating_state <> 'computed' AND rating IS NULL))
) WITHOUT ROWID;

CREATE TABLE tracked_player_aggregates (
  id INTEGER PRIMARY KEY,
  jfw_player_id TEXT NOT NULL REFERENCES tracked_players(jfw_player_id),
  product_season_id INTEGER NOT NULL REFERENCES product_seasons(id),
  competition_season_id INTEGER REFERENCES competition_seasons(id),
  team_id INTEGER REFERENCES teams(id),
  aggregate_scope TEXT NOT NULL CHECK (aggregate_scope IN ('season', 'competition', 'club', 'club_competition')),
  stats_json TEXT NOT NULL CHECK (json_valid(stats_json)),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  rebuilt_at TEXT NOT NULL CHECK (rebuilt_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE (jfw_player_id, product_season_id, aggregate_scope, competition_season_id, team_id),
  CHECK (
    (aggregate_scope = 'season' AND competition_season_id IS NULL AND team_id IS NULL) OR
    (aggregate_scope = 'competition' AND competition_season_id IS NOT NULL AND team_id IS NULL) OR
    (aggregate_scope = 'club' AND competition_season_id IS NULL AND team_id IS NOT NULL) OR
    (aggregate_scope = 'club_competition' AND competition_season_id IS NOT NULL AND team_id IS NOT NULL)
  )
);

CREATE TABLE correction_states (
  correction_key TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_canonical_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'provider_caught_up', 'review_required')),
  provider_baseline_json TEXT NOT NULL CHECK (json_valid(provider_baseline_json)),
  applied_value_json TEXT NOT NULL CHECK (json_valid(applied_value_json)),
  reason TEXT,
  source_url TEXT,
  verified_at TEXT CHECK (verified_at IS NULL OR verified_at GLOB '????-??-??T??:??:??*Z'),
  reconciled_sync_run_id INTEGER REFERENCES sync_runs(id),
  reconciled_at TEXT CHECK (reconciled_at IS NULL OR reconciled_at GLOB '????-??-??T??:??:??*Z')
);

CREATE INDEX idx_fixtures_date_kickoff ON fixtures(date_jst, kickoff_utc);
CREATE INDEX idx_fixtures_competition_date_kickoff ON fixtures(competition_season_id, date_jst, kickoff_utc);
CREATE INDEX idx_fixtures_status_date ON fixtures(status_short, date_jst);
CREATE INDEX idx_fixtures_home_kickoff ON fixtures(home_team_id, kickoff_utc DESC);
CREATE INDEX idx_fixtures_away_kickoff ON fixtures(away_team_id, kickoff_utc DESC);
CREATE UNIQUE INDEX ux_fixture_events_order ON fixture_events(fixture_revision_id, event_order);
CREATE INDEX idx_fixture_player_records_history ON fixture_player_records(player_id, kickoff_utc DESC);
CREATE INDEX idx_fixture_player_appearances_record_revision ON fixture_player_appearances(player_record_id, fixture_revision_id);
CREATE INDEX idx_player_team_memberships_period ON player_team_memberships(player_id, valid_from, valid_to);
CREATE INDEX idx_record_sources_fact ON record_sources(fact_kind, fact_key, observed_at DESC);
CREATE INDEX idx_tracking_periods_player_period ON tracking_periods(jfw_player_id, valid_from, valid_to);
CREATE UNIQUE INDEX ux_fixture_archives_active ON fixture_archives(fixture_revision_id) WHERE is_active = 1;
CREATE INDEX idx_tracked_aggregates_scope ON tracked_player_aggregates(product_season_id, aggregate_scope, competition_season_id, team_id);
CREATE INDEX idx_correction_states_target ON correction_states(target_canonical_id);
CREATE UNIQUE INDEX ux_tracked_aggregates_identity ON tracked_player_aggregates(
  jfw_player_id,
  product_season_id,
  aggregate_scope,
  COALESCE(competition_season_id, -1),
  COALESCE(team_id, -1)
);

CREATE TRIGGER fixtures_validate_published_revision_insert
BEFORE INSERT ON fixtures
WHEN NEW.published_revision IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM fixture_revisions r
    WHERE r.id = NEW.published_revision
      AND r.fixture_id = NEW.id
      AND r.lifecycle_state = 'published'
  ) THEN RAISE(ABORT, 'published_revision must be a published revision of the same fixture') END;
END;

CREATE TRIGGER fixtures_validate_published_revision_update
BEFORE UPDATE OF published_revision ON fixtures
WHEN NEW.published_revision IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM fixture_revisions r
    WHERE r.id = NEW.published_revision
      AND r.fixture_id = NEW.id
      AND r.lifecycle_state = 'published'
  ) THEN RAISE(ABORT, 'published_revision must be a published revision of the same fixture') END;
END;

CREATE TRIGGER fixture_revisions_protect_published_pointer
BEFORE UPDATE OF fixture_id, lifecycle_state ON fixture_revisions
WHEN EXISTS (SELECT 1 FROM fixtures f WHERE f.published_revision = OLD.id)
BEGIN
  SELECT CASE WHEN NEW.fixture_id <> OLD.fixture_id OR NEW.lifecycle_state <> 'published'
    THEN RAISE(ABORT, 'active published revision cannot change fixture or lifecycle') END;
END;

CREATE TRIGGER fixture_player_records_validate_team_insert
BEFORE INSERT ON fixture_player_records
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM fixtures f
    WHERE f.id = NEW.fixture_id
      AND NEW.team_id IN (f.home_team_id, f.away_team_id)
  ) THEN RAISE(ABORT, 'player record team must belong to fixture') END;
END;

CREATE TRIGGER fixture_player_records_validate_team_update
BEFORE UPDATE OF fixture_id, team_id, player_id ON fixture_player_records
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM fixture_player_appearances a
    JOIN fixture_revisions r ON r.id = a.fixture_revision_id
    WHERE a.player_record_id = OLD.id
      AND r.lifecycle_state IN ('published', 'superseded')
    UNION ALL
    SELECT 1 FROM jfw_rating_results j WHERE j.player_record_id = OLD.id
  ) THEN RAISE(ABORT, 'published player record identity is immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM fixtures f
    WHERE f.id = NEW.fixture_id
      AND NEW.team_id IN (f.home_team_id, f.away_team_id)
  ) THEN RAISE(ABORT, 'player record team must belong to fixture') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM fixture_player_appearances a
    JOIN fixture_revisions r ON r.id = a.fixture_revision_id
    WHERE a.player_record_id = OLD.id
      AND r.fixture_id <> NEW.fixture_id
  ) THEN RAISE(ABORT, 'player record fixture must match existing staging appearances') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM fixture_player_appearances a
    JOIN fixture_lineup_entries e ON e.player_appearance_id = a.id
    JOIN fixture_lineups l ON l.id = e.lineup_id
    WHERE a.player_record_id = OLD.id
      AND l.team_id <> NEW.team_id
  ) THEN RAISE(ABORT, 'player record team must match existing staging lineup entries') END;
END;

CREATE TRIGGER fixture_player_appearances_validate_scope_insert
BEFORE INSERT ON fixture_player_appearances
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM fixture_revisions r
    JOIN fixture_player_records p ON p.id = NEW.player_record_id
    WHERE r.id = NEW.fixture_revision_id
      AND r.fixture_id = p.fixture_id
  ) THEN RAISE(ABORT, 'appearance revision and player record must belong to same fixture') END;
END;

CREATE TRIGGER fixture_player_appearances_validate_scope_update
BEFORE UPDATE OF fixture_revision_id, player_record_id ON fixture_player_appearances
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM fixture_revisions r
    JOIN fixture_player_records p ON p.id = NEW.player_record_id
    WHERE r.id = NEW.fixture_revision_id
      AND r.fixture_id = p.fixture_id
  ) THEN RAISE(ABORT, 'appearance revision and player record must belong to same fixture') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM fixture_lineup_entries e
    JOIN fixture_lineups l ON l.id = e.lineup_id
    JOIN fixture_player_records p ON p.id = NEW.player_record_id
    WHERE e.player_appearance_id = OLD.id
      AND (l.fixture_revision_id <> NEW.fixture_revision_id OR l.team_id <> p.team_id)
  ) THEN RAISE(ABORT, 'appearance update must match existing lineup revision and team') END;
END;

CREATE TRIGGER fixture_lineup_entries_validate_scope_insert
BEFORE INSERT ON fixture_lineup_entries
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM fixture_lineups l
    JOIN fixture_player_appearances a ON a.id = NEW.player_appearance_id
    JOIN fixture_player_records p ON p.id = a.player_record_id
    WHERE l.id = NEW.lineup_id
      AND l.fixture_revision_id = a.fixture_revision_id
      AND l.team_id = p.team_id
  ) THEN RAISE(ABORT, 'lineup entry must match appearance revision and team') END;
END;

CREATE TRIGGER fixture_lineup_entries_validate_scope_update
BEFORE UPDATE OF lineup_id, player_appearance_id ON fixture_lineup_entries
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM fixture_lineups l
    JOIN fixture_player_appearances a ON a.id = NEW.player_appearance_id
    JOIN fixture_player_records p ON p.id = a.player_record_id
    WHERE l.id = NEW.lineup_id
      AND l.fixture_revision_id = a.fixture_revision_id
      AND l.team_id = p.team_id
  ) THEN RAISE(ABORT, 'lineup entry must match appearance revision and team') END;
END;

CREATE TRIGGER fixture_lineups_validate_scope_update
BEFORE UPDATE OF fixture_revision_id, team_id ON fixture_lineups
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM fixture_lineup_entries e
    JOIN fixture_player_appearances a ON a.id = e.player_appearance_id
    JOIN fixture_player_records p ON p.id = a.player_record_id
    WHERE e.lineup_id = OLD.id
      AND (a.fixture_revision_id <> NEW.fixture_revision_id OR p.team_id <> NEW.team_id)
  ) THEN RAISE(ABORT, 'lineup update must match existing appearance revision and team') END;
END;

CREATE TRIGGER fixture_team_stats_validate_team_insert
BEFORE INSERT ON fixture_team_stats
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM fixture_revisions r
    JOIN fixtures f ON f.id = r.fixture_id
    WHERE r.id = NEW.fixture_revision_id
      AND NEW.team_id IN (f.home_team_id, f.away_team_id)
  ) THEN RAISE(ABORT, 'team stats team must belong to fixture') END;
END;

CREATE TRIGGER fixture_team_stats_validate_team_update
BEFORE UPDATE OF fixture_revision_id, team_id ON fixture_team_stats
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM fixture_revisions r
    JOIN fixtures f ON f.id = r.fixture_id
    WHERE r.id = NEW.fixture_revision_id
      AND NEW.team_id IN (f.home_team_id, f.away_team_id)
  ) THEN RAISE(ABORT, 'team stats team must belong to fixture') END;
END;

CREATE TRIGGER jfw_rating_results_validate_scope_insert
BEFORE INSERT ON jfw_rating_results
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM fixture_player_records p
    JOIN fixture_revisions r ON r.id = NEW.rated_fixture_revision_id
    WHERE p.id = NEW.player_record_id
      AND p.fixture_id = r.fixture_id
  ) THEN RAISE(ABORT, 'rating revision and player record must belong to same fixture') END;
END;

CREATE TRIGGER jfw_rating_results_validate_scope_update
BEFORE UPDATE OF player_record_id, rated_fixture_revision_id ON jfw_rating_results
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM fixture_player_records p
    JOIN fixture_revisions r ON r.id = NEW.rated_fixture_revision_id
    WHERE p.id = NEW.player_record_id
      AND p.fixture_id = r.fixture_id
  ) THEN RAISE(ABORT, 'rating revision and player record must belong to same fixture') END;
END;

CREATE VIEW published_fixture_revisions AS
SELECT r.*
FROM fixture_revisions r
JOIN fixtures f ON f.id = r.fixture_id
WHERE f.published_revision = r.id
  AND r.lifecycle_state = 'published';

CREATE VIEW published_fixture_player_appearances AS
SELECT
  a.id,
  a.fixture_revision_id,
  a.player_record_id,
  p.fixture_id,
  p.team_id,
  p.player_id,
  p.kickoff_utc,
  a.appearance_state,
  a.position,
  a.minutes
FROM fixture_player_appearances a
JOIN fixture_revisions r ON r.id = a.fixture_revision_id
JOIN fixtures f ON f.id = r.fixture_id AND f.published_revision = r.id
JOIN fixture_player_records p ON p.id = a.player_record_id AND p.fixture_id = f.id
WHERE r.lifecycle_state = 'published';

CREATE VIEW published_jfw_rating_results AS
SELECT j.*
FROM jfw_rating_results j
JOIN fixture_player_records p ON p.id = j.player_record_id
JOIN fixtures f ON f.id = p.fixture_id AND f.published_revision = j.rated_fixture_revision_id
JOIN fixture_revisions r ON r.id = j.rated_fixture_revision_id
  AND r.fixture_id = f.id
  AND r.lifecycle_state = 'published';
