-- Provisional detail only. Core finalized revisions are never modified here.
CREATE TABLE IF NOT EXISTS live_details (
 fixture_id TEXT PRIMARY KEY,
 payload TEXT NOT NULL,
 updated_ms INTEGER NOT NULL
);
