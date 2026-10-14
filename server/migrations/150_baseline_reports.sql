-- The client-facing "day 0" snapshot document: what the site's KPIs and open
-- issues looked like at onboarding, generated once (see runBaselineSequence
-- in server/routes/clients.js) and never overwritten by later work — later
-- growth is measured AGAINST this, not by mutating it. One row per site,
-- same "set once, never backfilled" discipline as sites.onboarded_at
-- (migration 030).
CREATE TABLE IF NOT EXISTS baseline_reports (
  site_id       INT UNIQUE NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  kpi_snapshot  JSONB NOT NULL,
  issues_snapshot JSONB NOT NULL,
  narrative_md  TEXT NOT NULL
);
