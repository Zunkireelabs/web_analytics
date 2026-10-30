-- Shared counters for rate limiting the public sign-in / sign-up routes. In the database, not in
-- process memory, so the limit holds across every app instance and survives a restart.
-- One row per (route, IP or address) key; old rows are swept as a side effect of use.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);
