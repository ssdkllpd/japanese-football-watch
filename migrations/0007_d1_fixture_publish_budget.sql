PRAGMA foreign_keys = ON;

-- One row per actual public fixture detail publication. The UTC date is the
-- publication date, not the provider's fetched/reconciled timestamp.
CREATE TABLE fixture_detail_publish_days (
  date_utc TEXT NOT NULL CHECK (date_utc GLOB '????-??-??'),
  fixture_id TEXT NOT NULL CHECK (fixture_id GLOB 'af:fixture:*'),
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  published_at TEXT NOT NULL,
  PRIMARY KEY (date_utc, fixture_id)
) WITHOUT ROWID;

CREATE TRIGGER fixture_detail_publish_daily_cap
BEFORE INSERT ON fixture_detail_publish_days
WHEN (SELECT COUNT(*) FROM fixture_detail_publish_days
      WHERE date_utc = NEW.date_utc) >= 20
BEGIN
  SELECT RAISE(ABORT, 'D1 fixture publication daily cap reached');
END;
