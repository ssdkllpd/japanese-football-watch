-- Every mutable fixture header update leaves durable dates to rebuild, including result relocation.
CREATE TABLE date_index_repair_queue (
  date_jst TEXT PRIMARY KEY NOT NULL CHECK(date_jst GLOB '????-??-??'),
  repair_token TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
-- Retain the historical competition scopes even when an interrupted refresh
-- has already replaced the generic index and removed its coverage rows.
CREATE TABLE date_index_repair_scopes (
  date_jst TEXT NOT NULL,
  competition_id TEXT NOT NULL,
  PRIMARY KEY(date_jst,competition_id)
) WITHOUT ROWID;
CREATE TRIGGER fixture_date_repair_journal AFTER UPDATE OF
  kickoff_utc,date_jst,status_short,status_long,status_elapsed,ingestion_state,published_revision ON fixtures
WHEN OLD.kickoff_utc IS NOT NEW.kickoff_utc OR OLD.date_jst IS NOT NEW.date_jst
  OR OLD.status_short IS NOT NEW.status_short OR OLD.status_long IS NOT NEW.status_long
  OR OLD.status_elapsed IS NOT NEW.status_elapsed OR OLD.ingestion_state IS NOT NEW.ingestion_state
  OR OLD.published_revision IS NOT NEW.published_revision
BEGIN
  INSERT INTO date_index_repair_scopes(date_jst,competition_id)
    SELECT OLD.date_jst,competition.canonical_id FROM competition_seasons season
      JOIN competitions competition ON competition.id=season.competition_id
      WHERE season.id=OLD.competition_season_id
    ON CONFLICT(date_jst,competition_id) DO NOTHING;
  INSERT INTO date_index_repair_scopes(date_jst,competition_id)
    SELECT NEW.date_jst,competition.canonical_id FROM competition_seasons season
      JOIN competitions competition ON competition.id=season.competition_id
      WHERE season.id=NEW.competition_season_id
    ON CONFLICT(date_jst,competition_id) DO NOTHING;
  INSERT INTO date_index_repair_queue(date_jst,repair_token,changed_at)
    VALUES(OLD.date_jst,lower(hex(randomblob(16))),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(date_jst) DO UPDATE SET repair_token=excluded.repair_token,changed_at=excluded.changed_at;
  INSERT INTO date_index_repair_queue(date_jst,repair_token,changed_at)
    VALUES(NEW.date_jst,lower(hex(randomblob(16))),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(date_jst) DO UPDATE SET repair_token=excluded.repair_token,changed_at=excluded.changed_at;
END;

-- Registered scopes survive partial per-date repairs of a legacy checkpoint.
ALTER TABLE fixture_schedule_refresh_pending ADD COLUMN registered_dates_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(registered_dates_json) AND json_type(registered_dates_json)='array');
