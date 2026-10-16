CREATE TABLE IF NOT EXISTS live_dispatch_slots (
 slot_ms INTEGER PRIMARY KEY,
 attempted_ms INTEGER NOT NULL,
 state TEXT NOT NULL,
 http_status INTEGER,
 run_id INTEGER
);
