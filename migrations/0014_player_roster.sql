-- Roster observations are evidence on a date, not asserted transfer dates.
-- A complete ten-league scan is activated only after all batches arrive.
CREATE TABLE player_roster_sync_runs (
  run_id TEXT PRIMARY KEY CHECK (run_id GLOB '????-??-??T??:??:??*Z'),
  observed_on TEXT NOT NULL CHECK (observed_on GLOB '????-??-??'),
  completed_at TEXT CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??*Z'),
  player_count INTEGER CHECK (player_count IS NULL OR player_count > 0)
) WITHOUT ROWID;

CREATE TABLE player_roster_observations (
  run_id TEXT NOT NULL REFERENCES player_roster_sync_runs(run_id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  observed_on TEXT NOT NULL CHECK (observed_on GLOB '????-??-??'),
  source TEXT NOT NULL CHECK (source IN ('season_players', 'team_squad')),
  PRIMARY KEY (run_id, player_id, team_id, source)
) WITHOUT ROWID;

CREATE INDEX idx_player_roster_recent ON player_roster_observations(player_id, run_id DESC);
CREATE INDEX idx_player_roster_team ON player_roster_observations(run_id, team_id, player_id);
CREATE INDEX idx_players_nationality ON players(nationality, id);
