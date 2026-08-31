PRAGMA foreign_keys = ON;

-- Preserve the complete public standings DTO instead of only the compact
-- rank/points subset introduced with the core schema.
ALTER TABLE standings_snapshots ADD COLUMN contract_version TEXT
  CHECK (contract_version IS NULL OR contract_version = '2.0.0');
ALTER TABLE standings_snapshots ADD COLUMN section_presence TEXT
  CHECK (section_presence IS NULL OR section_presence IN ('present', 'provider_missing'));
ALTER TABLE standings_snapshots ADD COLUMN provenance_source TEXT;
ALTER TABLE standings_snapshots ADD COLUMN provenance_fetched_at TEXT;
ALTER TABLE standings_snapshots ADD COLUMN provenance_verification TEXT;
ALTER TABLE standings_snapshots ADD COLUMN provenance_issues_json TEXT;

ALTER TABLE standings_rows ADD COLUMN group_id TEXT;
ALTER TABLE standings_rows ADD COLUMN group_order INTEGER
  CHECK (group_order IS NULL OR group_order >= 0);
ALTER TABLE standings_rows ADD COLUMN row_order INTEGER
  CHECK (row_order IS NULL OR row_order >= 0);
ALTER TABLE standings_rows ADD COLUMN wins INTEGER
  CHECK (wins IS NULL OR wins >= 0);
ALTER TABLE standings_rows ADD COLUMN draws INTEGER
  CHECK (draws IS NULL OR draws >= 0);
ALTER TABLE standings_rows ADD COLUMN losses INTEGER
  CHECK (losses IS NULL OR losses >= 0);
ALTER TABLE standings_rows ADD COLUMN goals_for INTEGER
  CHECK (goals_for IS NULL OR goals_for >= 0);
ALTER TABLE standings_rows ADD COLUMN goals_against INTEGER
  CHECK (goals_against IS NULL OR goals_against >= 0);
ALTER TABLE standings_rows ADD COLUMN home_played INTEGER
  CHECK (home_played IS NULL OR home_played >= 0);
ALTER TABLE standings_rows ADD COLUMN home_wins INTEGER
  CHECK (home_wins IS NULL OR home_wins >= 0);
ALTER TABLE standings_rows ADD COLUMN home_draws INTEGER
  CHECK (home_draws IS NULL OR home_draws >= 0);
ALTER TABLE standings_rows ADD COLUMN home_losses INTEGER
  CHECK (home_losses IS NULL OR home_losses >= 0);
ALTER TABLE standings_rows ADD COLUMN home_goals_for INTEGER
  CHECK (home_goals_for IS NULL OR home_goals_for >= 0);
ALTER TABLE standings_rows ADD COLUMN home_goals_against INTEGER
  CHECK (home_goals_against IS NULL OR home_goals_against >= 0);
ALTER TABLE standings_rows ADD COLUMN away_played INTEGER
  CHECK (away_played IS NULL OR away_played >= 0);
ALTER TABLE standings_rows ADD COLUMN away_wins INTEGER
  CHECK (away_wins IS NULL OR away_wins >= 0);
ALTER TABLE standings_rows ADD COLUMN away_draws INTEGER
  CHECK (away_draws IS NULL OR away_draws >= 0);
ALTER TABLE standings_rows ADD COLUMN away_losses INTEGER
  CHECK (away_losses IS NULL OR away_losses >= 0);
ALTER TABLE standings_rows ADD COLUMN away_goals_for INTEGER
  CHECK (away_goals_for IS NULL OR away_goals_for >= 0);
ALTER TABLE standings_rows ADD COLUMN away_goals_against INTEGER
  CHECK (away_goals_against IS NULL OR away_goals_against >= 0);
ALTER TABLE standings_rows ADD COLUMN status TEXT;
ALTER TABLE standings_rows ADD COLUMN description TEXT;
ALTER TABLE standings_rows ADD COLUMN updated_at TEXT;
ALTER TABLE standings_rows ADD COLUMN provenance_source TEXT;
ALTER TABLE standings_rows ADD COLUMN provenance_fetched_at TEXT;
ALTER TABLE standings_rows ADD COLUMN provenance_verification TEXT;
ALTER TABLE standings_rows ADD COLUMN provenance_issues_json TEXT;

CREATE TABLE standings_groups (
  snapshot_id INTEGER NOT NULL REFERENCES standings_snapshots(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  group_order INTEGER NOT NULL CHECK (group_order >= 0),
  PRIMARY KEY (snapshot_id, group_id),
  UNIQUE (snapshot_id, group_name),
  UNIQUE (snapshot_id, group_order)
) WITHOUT ROWID;

CREATE UNIQUE INDEX ux_standings_rows_display_order
  ON standings_rows(snapshot_id, group_order, row_order);

CREATE TABLE standings_publications (
  competition_season_id INTEGER PRIMARY KEY
    REFERENCES competition_seasons(id) ON DELETE CASCADE,
  snapshot_id INTEGER NOT NULL UNIQUE
    REFERENCES standings_snapshots(id) ON DELETE CASCADE,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  identity_digest TEXT NOT NULL CHECK (
    length(identity_digest) = 64 AND identity_digest NOT GLOB '*[^0-9a-f]*'
  ),
  generated_at TEXT NOT NULL CHECK (
    generated_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', generated_at) = generated_at
  ),
  source_r2_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  )
) WITHOUT ROWID;

-- A publication is evidence for one exact reconstructed identity/order set.
-- Any later mutation removes that evidence; an importer publishes last.
CREATE TRIGGER standings_publication_invalidate_group_insert
AFTER INSERT ON standings_groups
BEGIN
  DELETE FROM standings_publications WHERE snapshot_id = NEW.snapshot_id;
END;

CREATE TRIGGER standings_publication_invalidate_group_update
AFTER UPDATE ON standings_groups
BEGIN
  DELETE FROM standings_publications WHERE snapshot_id IN (OLD.snapshot_id, NEW.snapshot_id);
END;

CREATE TRIGGER standings_publication_invalidate_group_delete
AFTER DELETE ON standings_groups
BEGIN
  DELETE FROM standings_publications WHERE snapshot_id = OLD.snapshot_id;
END;

CREATE TRIGGER standings_publication_invalidate_row_insert
AFTER INSERT ON standings_rows
BEGIN
  DELETE FROM standings_publications WHERE snapshot_id = NEW.snapshot_id;
END;

CREATE TRIGGER standings_publication_invalidate_row_update
AFTER UPDATE ON standings_rows
BEGIN
  DELETE FROM standings_publications WHERE snapshot_id IN (OLD.snapshot_id, NEW.snapshot_id);
END;

CREATE TRIGGER standings_publication_invalidate_row_delete
AFTER DELETE ON standings_rows
BEGIN
  DELETE FROM standings_publications WHERE snapshot_id = OLD.snapshot_id;
END;

CREATE TRIGGER standings_publication_invalidate_snapshot_update
AFTER UPDATE ON standings_snapshots
BEGIN
  DELETE FROM standings_publications WHERE snapshot_id IN (OLD.id, NEW.id);
END;
