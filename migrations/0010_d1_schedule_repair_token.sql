-- Keep existing repair checkpoints readable; new updates supply a unique operation token.
ALTER TABLE fixture_schedule_refresh_pending ADD COLUMN repair_token TEXT NOT NULL DEFAULT '';
