-- Verify stage: "fixed" is never actually re-verified today — Watchlist
-- completion is a heuristic (a draft happened to exist since the finding
-- was discovered). This table records a real, scheduled re-check of the
-- EXACT flagged page against the EXACT deterministic check that originally
-- flagged it, once a draft is marked implemented (see markDraftImplemented
-- in server/store/drafts.js and runDueVerifications in
-- server/agents/lib/fix-verification.js). verify_after defaults to +48h
-- (real deploy-propagation delay) at insert time, not here.
CREATE TABLE IF NOT EXISTS fix_verifications (
  id                 SERIAL PRIMARY KEY,
  site_id            INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  watchlist_item_id  INT REFERENCES watchlist_items(id) ON DELETE CASCADE,
  finding_id         TEXT NOT NULL,
  draft_id           INT REFERENCES drafts(id) ON DELETE CASCADE,
  page_url           TEXT NOT NULL,
  generator_id       TEXT NOT NULL,
  query              TEXT,
  verify_after       TIMESTAMPTZ NOT NULL,
  checked_at         TIMESTAMPTZ,
  outcome            TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'verified-fixed', 'still-present', 'unreachable')),
  evidence           JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fix_verifications_due ON fix_verifications (outcome, verify_after);
