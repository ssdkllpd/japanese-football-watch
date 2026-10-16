-- Preserve all existing receipts and their UTC-day/fixture uniqueness. Their
-- source is unknown; do not relabel historical manual work as automation.
ALTER TABLE fixture_detail_publish_days ADD COLUMN publication_source TEXT
  NOT NULL DEFAULT 'legacy' CHECK (publication_source IN ('legacy', 'manual', 'automation'));

CREATE TRIGGER fixture_detail_publish_automation_cap
BEFORE INSERT ON fixture_detail_publish_days
WHEN NEW.publication_source = 'automation' AND
  (SELECT COUNT(*) FROM fixture_detail_publish_days
   WHERE date_utc = NEW.date_utc AND publication_source = 'automation') >= 40
BEGIN
  SELECT RAISE(ABORT, 'D1 automation publication daily cap reached');
END;
