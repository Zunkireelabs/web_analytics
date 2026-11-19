-- Protected-page title trials (server/agents/lib/protected-title-trials.js).
--
-- A page that already earns clicks is "protected": a title/description change there normally waits for a person
-- (protected-pages.js). The owner chose (2026-11-18) to let a LIMITED number of those title changes ship on their own,
-- at most PROTECTED_TITLE_WEEKLY_LIMIT per project per 7 days, each one recorded here with the title and description
-- it replaced, so that when the fix's measured impact (fix_impact, ~31 days after merge) shows a real click drop the
-- old title and description are put back automatically.
--
-- Additive and idempotent; no data statements.
CREATE TABLE IF NOT EXISTS protected_title_trials (
  id                 BIGSERIAL   PRIMARY KEY,
  site_id            INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  recommendation_id  INTEGER,
  draft_id           INTEGER     NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  page               TEXT        NOT NULL,
  query              TEXT,
  previous_title     TEXT,         -- what the page had before; NULL = could not be read, so it can never be restored
  previous_description TEXT,
  new_title          TEXT,
  status             TEXT        NOT NULL DEFAULT 'shipped'
                     CHECK (status IN ('shipped', 'kept', 'restore-queued', 'not-restorable')),
  verdict            TEXT,         -- fix_impact's verdict once measured (impact-positive / -negative / -inconclusive)
  restore_recommendation_id INTEGER,
  shipped_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS protected_title_trials_draft_idx ON protected_title_trials (draft_id);
CREATE INDEX IF NOT EXISTS protected_title_trials_site_week_idx ON protected_title_trials (site_id, shipped_at);
