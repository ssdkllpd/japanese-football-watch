PRAGMA foreign_keys = ON;

-- D1 rejects the long timestamp GLOB introduced by migration 0002 as a
-- pattern that is too complex. Rebuild the parent and child coverage tables
-- together, preserving their rows and all invalidation behavior, while using
-- the canonical strftime check already proven for standings publications.

DROP TRIGGER date_index_coverage_invalidate_fixture_replace;
DROP TRIGGER date_index_coverage_invalidate_fixture_insert;
DROP TRIGGER date_index_coverage_invalidate_season_scope_update;
DROP TRIGGER date_index_coverage_invalidate_season_insert;
DROP TRIGGER date_index_coverage_invalidate_season_delete;
DROP TRIGGER date_index_coverage_invalidate_competition_identity_update;
DROP TRIGGER date_index_coverage_invalidate_fixture_delete;
DROP TRIGGER date_index_coverage_invalidate_fixture_scope_update;

CREATE TABLE date_index_coverages_v6 (
  date_jst TEXT PRIMARY KEY NOT NULL CHECK (
    date_jst GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
    AND date(date_jst, '+0 days') IS date_jst
  ),
  fixture_count INTEGER NOT NULL CHECK (fixture_count >= 0),
  fixture_id_digest TEXT NOT NULL CHECK (
    length(fixture_id_digest) = 64 AND fixture_id_digest NOT GLOB '*[^0-9a-f]*'
  ),
  generated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', generated_at) IS generated_at
  ),
  source_r2_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE competition_date_index_coverages_v6 (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  date_jst TEXT NOT NULL REFERENCES date_index_coverages_v6(date_jst) ON DELETE CASCADE,
  fixture_count INTEGER NOT NULL CHECK (fixture_count >= 0),
  fixture_id_digest TEXT NOT NULL CHECK (
    length(fixture_id_digest) = 64 AND fixture_id_digest NOT GLOB '*[^0-9a-f]*'
  ),
  generated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', generated_at) IS generated_at
  ),
  source_r2_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (competition_id, date_jst)
) WITHOUT ROWID;

INSERT INTO date_index_coverages_v6(
  date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
)
SELECT date_jst, fixture_count, fixture_id_digest, generated_at, source_r2_key, source_sha256
FROM date_index_coverages;

INSERT INTO competition_date_index_coverages_v6(
  competition_id, date_jst, fixture_count, fixture_id_digest,
  generated_at, source_r2_key, source_sha256
)
SELECT competition_id, date_jst, fixture_count, fixture_id_digest,
  generated_at, source_r2_key, source_sha256
FROM competition_date_index_coverages;

DROP TABLE competition_date_index_coverages;
DROP TABLE date_index_coverages;
ALTER TABLE date_index_coverages_v6 RENAME TO date_index_coverages;
ALTER TABLE competition_date_index_coverages_v6 RENAME TO competition_date_index_coverages;

CREATE INDEX idx_competition_date_coverages_date
  ON competition_date_index_coverages(date_jst, competition_id);

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
