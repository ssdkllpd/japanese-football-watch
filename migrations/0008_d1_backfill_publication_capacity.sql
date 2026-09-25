-- Permit bounded same-day manual catch-up while each workflow run remains
-- limited to 20 fixture details. The ledger still spans all publication paths.
DROP TRIGGER fixture_detail_publish_daily_cap;

CREATE TRIGGER fixture_detail_publish_daily_cap
BEFORE INSERT ON fixture_detail_publish_days
WHEN (SELECT COUNT(*) FROM fixture_detail_publish_days
      WHERE date_utc = NEW.date_utc) >= 240
BEGIN
  SELECT RAISE(ABORT, 'D1 fixture publication daily cap reached');
END;
