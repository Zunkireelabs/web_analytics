-- Audit trail for the Website Capability Discovery and Repair mechanism
-- (autoHealFileMapping's new evidence tiers, autoHealNewContentTarget).
-- One row per attempt, success or not, so an "ambiguous" or
-- "foreign-domain" outcome is as visible to a human as a repaired one —
-- recommendations.blocked_reason only ever showed the LATEST state, never
-- what was tried and why it didn't qualify.
CREATE TABLE IF NOT EXISTS capability_repairs (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  capability_type TEXT NOT NULL CHECK (capability_type IN ('url-file-map-page', 'new-content-target')),
  target TEXT NOT NULL, -- the page URL for url-file-map-page, the actionType for new-content-target
  outcome TEXT NOT NULL CHECK (outcome IN ('repaired', 'ambiguous', 'foreign-domain', 'not-found')),
  -- evidence_tier names WHICH evidence source produced a repair (e.g.
  -- 'sibling-pattern', 'permalink-search', 'filename-match', 'directory-scan')
  -- — null when outcome isn't 'repaired'. detail carries the candidate
  -- file(s)/directory considered, never free-text guesswork.
  evidence_tier TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capability_repairs_site ON capability_repairs (site_id, created_at DESC);
