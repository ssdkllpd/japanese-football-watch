PRAGMA foreign_keys = ON;

-- Keep one source of truth for standings group identity and display order.
-- Preflight must prove group_id and row_order contain no NULL values before
-- this migration is applied to a populated database.
CREATE TABLE standings_rows_v4 (
  snapshot_id INTEGER NOT NULL REFERENCES standings_snapshots(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  rank INTEGER CHECK (rank IS NULL OR rank > 0),
  points INTEGER,
  played INTEGER CHECK (played IS NULL OR played >= 0),
  goal_difference INTEGER,
  form TEXT,
  group_id TEXT NOT NULL,
  row_order INTEGER NOT NULL CHECK (row_order >= 0),
  wins INTEGER CHECK (wins IS NULL OR wins >= 0),
  draws INTEGER CHECK (draws IS NULL OR draws >= 0),
  losses INTEGER CHECK (losses IS NULL OR losses >= 0),
  goals_for INTEGER CHECK (goals_for IS NULL OR goals_for >= 0),
  goals_against INTEGER CHECK (goals_against IS NULL OR goals_against >= 0),
  home_played INTEGER CHECK (home_played IS NULL OR home_played >= 0),
  home_wins INTEGER CHECK (home_wins IS NULL OR home_wins >= 0),
  home_draws INTEGER CHECK (home_draws IS NULL OR home_draws >= 0),
  home_losses INTEGER CHECK (home_losses IS NULL OR home_losses >= 0),
  home_goals_for INTEGER CHECK (home_goals_for IS NULL OR home_goals_for >= 0),
  home_goals_against INTEGER CHECK (home_goals_against IS NULL OR home_goals_against >= 0),
  away_played INTEGER CHECK (away_played IS NULL OR away_played >= 0),
  away_wins INTEGER CHECK (away_wins IS NULL OR away_wins >= 0),
  away_draws INTEGER CHECK (away_draws IS NULL OR away_draws >= 0),
  away_losses INTEGER CHECK (away_losses IS NULL OR away_losses >= 0),
  away_goals_for INTEGER CHECK (away_goals_for IS NULL OR away_goals_for >= 0),
  away_goals_against INTEGER CHECK (away_goals_against IS NULL OR away_goals_against >= 0),
  status TEXT,
  description TEXT,
  updated_at TEXT,
  provenance_source TEXT,
  provenance_fetched_at TEXT,
  provenance_verification TEXT,
  provenance_issues_json TEXT,
  PRIMARY KEY (snapshot_id, group_id, team_id),
  UNIQUE (snapshot_id, group_id, row_order),
  FOREIGN KEY (snapshot_id, group_id)
    REFERENCES standings_groups(snapshot_id, group_id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO standings_rows_v4(
  snapshot_id, team_id, rank, points, played, goal_difference, form,
  group_id, row_order, wins, draws, losses, goals_for, goals_against,
  home_played, home_wins, home_draws, home_losses, home_goals_for, home_goals_against,
  away_played, away_wins, away_draws, away_losses, away_goals_for, away_goals_against,
  status, description, updated_at, provenance_source, provenance_fetched_at,
  provenance_verification, provenance_issues_json
)
SELECT
  snapshot_id, team_id, rank, points, played, goal_difference, form,
  group_id, row_order, wins, draws, losses, goals_for, goals_against,
  home_played, home_wins, home_draws, home_losses, home_goals_for, home_goals_against,
  away_played, away_wins, away_draws, away_losses, away_goals_for, away_goals_against,
  status, description, updated_at, provenance_source, provenance_fetched_at,
  provenance_verification, provenance_issues_json
FROM standings_rows;

DROP TABLE standings_rows;
ALTER TABLE standings_rows_v4 RENAME TO standings_rows;

-- Table reconstruction removes table-owned triggers, so recreate all three.
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

-- fixtures is deliberately not rebuilt: its child graph contains cascading
-- detail tables. These triggers provide the required cross-column invariant.
CREATE TRIGGER fixtures_validate_date_jst_insert
BEFORE INSERT ON fixtures
WHEN NEW.date_jst <> date(NEW.kickoff_utc, '+9 hours')
BEGIN
  SELECT RAISE(ABORT, 'date_jst must be the Asia/Tokyo calendar date of kickoff_utc');
END;

CREATE TRIGGER fixtures_validate_date_jst_update
BEFORE UPDATE OF kickoff_utc, date_jst ON fixtures
WHEN NEW.date_jst <> date(NEW.kickoff_utc, '+9 hours')
BEGIN
  SELECT RAISE(ABORT, 'date_jst must be the Asia/Tokyo calendar date of kickoff_utc');
END;
