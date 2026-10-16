-- Operator-only diagnostics. Never exposed through the public live endpoint.
CREATE TABLE IF NOT EXISTS live_provider_errors (
 id INTEGER PRIMARY KEY,
 at_ms INTEGER NOT NULL,
 endpoint TEXT NOT NULL,
 http_status INTEGER NOT NULL,
 error_detail TEXT NOT NULL
);
