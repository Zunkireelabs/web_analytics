-- Real "day 0" anchor for a client's engagement — every growth/review
-- calculation (Growth Report, Review Report, future phases) reads from
-- this instead of an arbitrary lookback window. Set once, at the moment
-- GSC/GA4 are first connected and the first real baseline agent run
-- completes (server/routes/clients.js) — never backfilled/guessed for a
-- site that was already running before this column existed.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS baseline_run_id INTEGER REFERENCES agent_runs(id);
