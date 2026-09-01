-- D1 enforces foreign keys unconditionally and does not let a query or a
-- migration change that; this line is a no-op there and is kept only so a
-- local SQLite driver with foreign keys off cannot silently skip the
-- constraints. It is NOT a way to disable them: a later table rebuild in D1
-- still fires ON DELETE CASCADE. Use PRAGMA defer_foreign_keys instead.
PRAGMA foreign_keys = ON;

-- A row exists only after a complete response-ready R2 date index has been
-- validated against the exact fixture identity set stored in D1. Absence is
-- therefore "not migrated", never an implicit empty result.
CREATE TABLE date_index_coverages (
  date_jst TEXT PRIMARY KEY NOT NULL CHECK (
    date_jst GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
    AND date(date_jst, '+0 days') IS date_jst
  ),
  fixture_count INTEGER NOT NULL CHECK (fixture_count >= 0),
  fixture_id_digest TEXT NOT NULL CHECK (
    length(fixture_id_digest) = 64 AND fixture_id_digest NOT GLOB '*[^0-9a-f]*'
  ),
  generated_at TEXT NOT NULL CHECK (
    generated_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', generated_at) IS generated_at
  ),
  source_r2_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE competition_date_index_coverages (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  date_jst TEXT NOT NULL REFERENCES date_index_coverages(date_jst) ON DELETE CASCADE,
  fixture_count INTEGER NOT NULL CHECK (fixture_count >= 0),
  fixture_id_digest TEXT NOT NULL CHECK (
    length(fixture_id_digest) = 64 AND fixture_id_digest NOT GLOB '*[^0-9a-f]*'
  ),
  generated_at TEXT NOT NULL CHECK (
    generated_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', generated_at) IS generated_at
  ),
  source_r2_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (competition_id, date_jst)
) WITHOUT ROWID;

CREATE INDEX idx_competition_date_coverages_date
  ON competition_date_index_coverages(date_jst, competition_id);

-- Coverage proves the exact fixture identity/scope set at import time. Direct
-- fixture writes invalidate affected dates. The read path independently checks
-- fixture_id_digest, so writers outside these triggers still fail closed.
CREATE TRIGGER date_index_coverage_invalidate_fixture_replace
BEFORE INSERT ON fixtures
WHEN EXISTS (
  SELECT 1 FROM fixtures existing
  WHERE existing.id = NEW.id
     OR existing.canonical_id = NEW.canonical_id
     OR (existing.source_id = NEW.source_id AND existing.provider_id = NEW.provider_id)
)
BEGIN
  DELETE FROM competition_date_index_coverages
  WHERE date_jst IN (
    SELECT date_jst FROM fixtures existing
    WHERE existing.id = NEW.id
       OR existing.canonical_id = NEW.canonical_id
       OR (existing.source_id = NEW.source_id AND existing.provider_id = NEW.provider_id)
  );
  DELETE FROM date_index_coverages
  WHERE date_jst IN (
    SELECT date_jst FROM fixtures existing
    WHERE existing.id = NEW.id
       OR existing.canonical_id = NEW.canonical_id
       OR (existing.source_id = NEW.source_id AND existing.provider_id = NEW.provider_id)
  );
END;

CREATE TRIGGER date_index_coverage_invalidate_fixture_insert
AFTER INSERT ON fixtures
BEGIN
  DELETE FROM competition_date_index_coverages WHERE date_jst = NEW.date_jst;
  DELETE FROM date_index_coverages WHERE date_jst = NEW.date_jst;
END;

-- Competition scope is indirect through competition_seasons. Re-parenting a
-- season must invalidate both the old and new competition/date coverage rows.
CREATE TRIGGER date_index_coverage_invalidate_season_scope_update
AFTER UPDATE OF competition_id ON competition_seasons
WHEN OLD.competition_id IS NOT NEW.competition_id
BEGIN
  DELETE FROM competition_date_index_coverages
  WHERE competition_id IN (OLD.competition_id, NEW.competition_id)
    AND date_jst IN (
      SELECT DISTINCT date_jst FROM fixtures
      WHERE competition_season_id = NEW.id
    );
END;

CREATE TRIGGER date_index_coverage_invalidate_season_insert
AFTER INSERT ON competition_seasons
BEGIN
  DELETE FROM competition_date_index_coverages
  WHERE competition_id = NEW.competition_id
    AND date_jst IN (
      SELECT DISTINCT date_jst FROM fixtures
      WHERE competition_season_id = NEW.id
    );
END;

CREATE TRIGGER date_index_coverage_invalidate_season_delete
BEFORE DELETE ON competition_seasons
BEGIN
  DELETE FROM competition_date_index_coverages
  WHERE competition_id = OLD.competition_id
    AND date_jst IN (
      SELECT DISTINCT date_jst FROM fixtures
      WHERE competition_season_id = OLD.id
    );
END;

CREATE TRIGGER date_index_coverage_invalidate_competition_identity_update
AFTER UPDATE OF canonical_id ON competitions
WHEN OLD.canonical_id IS NOT NEW.canonical_id
BEGIN
  DELETE FROM competition_date_index_coverages WHERE competition_id = NEW.id;
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
