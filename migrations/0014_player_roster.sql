-- A complete roster run is activated only after every identity and observation
-- is stored. Observation dates are evidence, not asserted transfer dates.
CREATE TABLE player_roster_sync_runs (
  run_id TEXT PRIMARY KEY,
  observed_on TEXT NOT NULL,
  completed_at TEXT,
  player_count INTEGER
);
CREATE TABLE player_roster_observations (
  run_id TEXT NOT NULL REFERENCES player_roster_sync_runs(run_id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  observed_on TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('season_players', 'team_squad')),
  PRIMARY KEY (run_id, player_id, team_id, source)
) WITHOUT ROWID;
CREATE INDEX idx_player_roster_history ON player_roster_observations(player_id, run_id DESC);
CREATE INDEX idx_player_roster_team ON player_roster_observations(run_id, team_id, source);
CREATE INDEX idx_players_nationality ON players(nationality, id);
ALTER TABLE players ADD COLUMN roster_profile_updated_at TEXT;
ALTER TABLE players ADD COLUMN position TEXT;
