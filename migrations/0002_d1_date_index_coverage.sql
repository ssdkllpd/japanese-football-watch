PRAGMA foreign_keys = ON;

-- A row exists only after a complete response-ready R2 date index has been
-- validated against the exact fixture identity set stored in D1. Absence is
-- therefore "not migrated", never an implicit empty result.
CREATE TABLE date_index_coverages (
  date_jst TEXT PRIMARY KEY NOT NULL CHECK (date_jst GLOB '????-??-??'),
  fixture_count INTEGER NOT NULL CHECK (fixture_count >= 0),
  generated_at TEXT NOT NULL CHECK (generated_at GLOB '????-??-??T??:??:??*Z'),
  source_r2_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64)
);

CREATE TABLE competition_date_index_coverages (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  date_jst TEXT NOT NULL REFERENCES date_index_coverages(date_jst) ON DELETE CASCADE,
  fixture_count INTEGER NOT NULL CHECK (fixture_count >= 0),
  generated_at TEXT NOT NULL CHECK (generated_at GLOB '????-??-??T??:??:??*Z'),
  source_r2_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  PRIMARY KEY (competition_id, date_jst)
) WITHOUT ROWID;

CREATE INDEX idx_competition_date_coverages_date
  ON competition_date_index_coverages(date_jst, competition_id);

-- Coverage proves the exact fixture identity/scope set at import time. Any
-- later identity or scope mutation invalidates the generic row and, through
-- its foreign key, every competition row for that date.
CREATE TRIGGER date_index_coverage_invalidate_fixture_insert
AFTER INSERT ON fixtures
BEGIN
  DELETE FROM competition_date_index_coverages WHERE date_jst = NEW.date_jst;
  DELETE FROM date_index_coverages WHERE date_jst = NEW.date_jst;
END;

CREATE TRIGGER date_index_coverage_invalidate_fixture_delete
AFTER DELETE ON fixtures
BEGIN
  DELETE FROM competition_date_index_coverages WHERE date_jst = OLD.date_jst;
  DELETE FROM date_index_coverages WHERE date_jst = OLD.date_jst;
END;

CREATE TRIGGER date_index_coverage_invalidate_fixture_scope_update
AFTER UPDATE OF canonical_id, competition_season_id, date_jst ON fixtures
WHEN OLD.canonical_id IS NOT NEW.canonical_id
  OR OLD.competition_season_id IS NOT NEW.competition_season_id
  OR OLD.date_jst IS NOT NEW.date_jst
BEGIN
  DELETE FROM competition_date_index_coverages WHERE date_jst IN (OLD.date_jst, NEW.date_jst);
  DELETE FROM date_index_coverages WHERE date_jst IN (OLD.date_jst, NEW.date_jst);
END;
