-- This schema belongs only to jfw-football-live, never the core database.
CREATE TABLE IF NOT EXISTS live_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT OR IGNORE INTO live_schema VALUES(1,1);
CREATE TABLE IF NOT EXISTS live_control (
 id INTEGER PRIMARY KEY CHECK(id=1), lease_owner TEXT, lease_until_ms INTEGER NOT NULL DEFAULT 0,
 last_tick_ms INTEGER NOT NULL DEFAULT 0, heartbeat_ms INTEGER NOT NULL DEFAULT 0,
 last_success_ms INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'disabled', error_code TEXT, daily_day TEXT,
 last_poll_ms INTEGER, next_start_ms INTEGER, provider_probe_ms INTEGER, last_core_sync_ms INTEGER
);
INSERT OR IGNORE INTO live_control(id) VALUES(1);
CREATE TABLE IF NOT EXISTS live_budget (
 utc_day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0,
 rows_written INTEGER NOT NULL DEFAULT 0, remaining INTEGER, checked_ms INTEGER
);
CREATE TABLE IF NOT EXISTS live_schedule (
 fixture_id TEXT PRIMARY KEY, provider_id INTEGER NOT NULL UNIQUE, competition_id INTEGER NOT NULL,
 kickoff_ms INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
 check_2h_ms INTEGER, check_1h_ms INTEGER, last_check_ms INTEGER,
 missing_since_ms INTEGER, last_seen_ms INTEGER, core_kickoff_ms INTEGER
);
CREATE INDEX IF NOT EXISTS live_schedule_kickoff ON live_schedule(kickoff_ms);
CREATE TABLE IF NOT EXISTS live_snapshots (
 fixture_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS live_date_checks (date_jst TEXT PRIMARY KEY, checked_ms INTEGER NOT NULL);
