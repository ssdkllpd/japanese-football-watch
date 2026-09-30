PRAGMA foreign_keys = ON;

-- Keep a durable repair record when D1 has changed but R2 date indexes have not.
CREATE TABLE fixture_schedule_refresh_pending (
  fixture_id TEXT PRIMARY KEY CHECK (fixture_id GLOB 'af:fixture:*'),
  old_date_jst TEXT NOT NULL,
  new_date_jst TEXT NOT NULL,
  changed_at TEXT NOT NULL
) WITHOUT ROWID;
