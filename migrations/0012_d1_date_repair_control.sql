-- Keep failed dates visible and retain the evidence for explicitly approved recovery.
CREATE TABLE date_index_repair_failures (
  id INTEGER PRIMARY KEY,
  date_jst TEXT NOT NULL,
  repair_token TEXT,
  attempted_at TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX date_repair_failures_date ON date_index_repair_failures(date_jst, attempted_at);
-- Bind result-publication relocations to their fixture until both dates converge.
CREATE TABLE date_index_repair_fixture_dates (
  fixture_id TEXT NOT NULL,
  date_jst TEXT NOT NULL,
  PRIMARY KEY(fixture_id,date_jst)
) WITHOUT ROWID;
CREATE INDEX date_repair_fixture_dates_date ON date_index_repair_fixture_dates(date_jst);
CREATE TRIGGER fixture_date_repair_ownership AFTER UPDATE OF
  kickoff_utc,date_jst,status_short,status_long,status_elapsed,ingestion_state,published_revision ON fixtures
WHEN OLD.kickoff_utc IS NOT NEW.kickoff_utc OR OLD.date_jst IS NOT NEW.date_jst
  OR OLD.status_short IS NOT NEW.status_short OR OLD.status_long IS NOT NEW.status_long
  OR OLD.status_elapsed IS NOT NEW.status_elapsed OR OLD.ingestion_state IS NOT NEW.ingestion_state
  OR OLD.published_revision IS NOT NEW.published_revision
BEGIN
  INSERT INTO date_index_repair_fixture_dates(fixture_id,date_jst) VALUES(NEW.canonical_id,OLD.date_jst)
    ON CONFLICT(fixture_id,date_jst) DO NOTHING;
  INSERT INTO date_index_repair_fixture_dates(fixture_id,date_jst) VALUES(NEW.canonical_id,NEW.date_jst)
    ON CONFLICT(fixture_id,date_jst) DO NOTHING;
END;
INSERT INTO date_index_repair_fixture_dates(fixture_id,date_jst)
  SELECT fixture_id,old_date_jst FROM fixture_schedule_refresh_pending
  UNION SELECT fixture_id,new_date_jst FROM fixture_schedule_refresh_pending;
CREATE TABLE date_index_repair_authorizations (
  date_jst TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  orphan_ids_json TEXT NOT NULL CHECK(json_valid(orphan_ids_json) AND json_type(orphan_ids_json)='array'),
  allow_invalid INTEGER NOT NULL CHECK(allow_invalid IN (0,1)),
  reason TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY(date_jst, source_sha256)
);
