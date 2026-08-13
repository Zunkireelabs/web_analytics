-- Closes the loop between "we shipped a fix" and "did it actually do anything".
--
-- Two things already look at a merged fix, and neither answers this question:
--   * fix_verifications (033) re-checks the LIVE PAGE 48h later to confirm the
--     issue is genuinely gone. That is correctness — the fix applied — not
--     impact.
--   * growth-projection.js FORECASTS what open findings might be worth. That is
--     an estimate about the future, computed before anything ships.
-- Nothing measured what a merged fix did to real Search Console numbers, so
-- every expectedImpact this system produces has never once been checked against
-- an outcome.
--
-- One row per implemented draft. `page_url` is nullable because site-level
-- fixes (llms-txt, robots-fix, sitemap, security-headers) genuinely have no
-- single page to attribute to — those are recorded as 'unmeasurable' rather
-- than being silently attributed to the homepage.
--
-- IMPORTANT, and reflected in the column names: this measures CORRELATION, not
-- causation. A page's impressions move for many reasons — seasonality, an
-- algorithm update, a competitor, other work shipped the same week. The columns
-- are deliberately named before_window/after_window/delta rather than anything
-- like "gain" or "caused", and agents/lib/fix-impact.js labels every result
-- basis: 'observed'. Treating a delta here as proof a fix worked would be
-- exactly the kind of invented conclusion this codebase refuses everywhere else.

CREATE TABLE IF NOT EXISTS fix_impact (
  id             SERIAL PRIMARY KEY,
  site_id        INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  draft_id       INT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  page_url       TEXT,
  generator_id   TEXT NOT NULL,
  merged_at      TIMESTAMPTZ NOT NULL,
  measure_after  TIMESTAMPTZ NOT NULL,
  measured_at    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'measured', 'insufficient-data', 'unmeasurable')),
  before_window  JSONB,
  after_window   JSONB,
  delta          JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One measurement per draft. Re-implementing the same draft (a revert then a
-- re-merge) should update the existing row rather than accumulate duplicates
-- that would each report the same window twice.
CREATE UNIQUE INDEX IF NOT EXISTS fix_impact_draft_idx ON fix_impact (draft_id);

-- The due-sweep's access pattern, matching idx_fix_verifications_due's shape.
CREATE INDEX IF NOT EXISTS fix_impact_due_idx ON fix_impact (status, measure_after);
