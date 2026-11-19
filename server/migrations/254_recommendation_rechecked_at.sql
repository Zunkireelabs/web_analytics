-- When the nightly sweep (agents/lib/nightly-recheck.js) last re-read the live page behind an open recommendation. Lets the sweep
-- go oldest-first so no open issue is starved, however many there are. Additive; NULL = never re-checked by the sweep.
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS last_rechecked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS recommendations_recheck_idx ON recommendations (site_id, last_rechecked_at NULLS FIRST) WHERE status = 'open';
