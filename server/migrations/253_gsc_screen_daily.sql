-- Search Console's own daily totals, exactly as its screen shows them (owner's rule, 2026-11-18: the Overview must match
-- Search Console to the number). Kept SEPARATE from gsc_daily on purpose:
--   gsc_daily        final data only, own-domain pages only, ~3 days behind. The Analyst, fix measurement and recommendations read it.
--   gsc_screen_daily fresh ('all' data state) up to the latest day, EVERY page and subdomain of the property, like the screen.
--                    Only the Overview's totals and chart read it; where a day is missing there they fall back to gsc_daily.
-- A day stays fresh until Google finalises it: the refresh job re-reads the last days every few hours.
-- Additive and idempotent; no data statements.
CREATE TABLE IF NOT EXISTS gsc_screen_daily (
  site_id     INT         NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date        DATE        NOT NULL,
  clicks      INT         NOT NULL,
  impressions INT         NOT NULL,
  ctr         NUMERIC(7,5),
  position    NUMERIC(6,2),
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, date)
);
ALTER TABLE gsc_screen_daily ENABLE ROW LEVEL SECURITY;
