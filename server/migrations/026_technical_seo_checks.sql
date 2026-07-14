-- Per-page technical SEO check results (server/agents/technical-seo.js).
-- `checked_at` starts NULL and drives the daily rotation query (ORDER BY
-- checked_at ASC NULLS FIRST) — GSC's URL Inspection API has a low quota
-- shared across every client site on this platform's one OAuth credential
-- (server/auth/google.js), so this agent checks a bounded rotating sample
-- of pages per day (worst/stalest first) rather than falsely claiming
-- full-site daily coverage. Full coverage completes over ~1 week instead.
--
-- Each of the four result columns is independently optional/nullable and
-- carries its own {ok, error, ...} — Core Web Vitals in particular is
-- absent whenever PAGESPEED_API_KEY isn't configured, or a page has no real
-- CrUX field data, and that must degrade honestly per-column rather than
-- failing the whole row.
CREATE TABLE IF NOT EXISTS technical_seo_checks (
  id                SERIAL PRIMARY KEY,
  site_id           INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page              TEXT NOT NULL,
  checked_at        TIMESTAMPTZ,
  index_status      JSONB,   -- {ok, error, coverageState, indexingState, robotsTxtState, googleCanonical, userCanonical, lastCrawlTime}
  core_web_vitals   JSONB,   -- {ok, error, dataSource: 'field'|'lab', lcp, inp, cls, category}
  technical_audit   JSONB,   -- {ok, error, hasCanonical, hasSchema, schemaTypes, title}
  broken_links      JSONB,   -- {ok, error, checked, broken: [{href,status,error}], redirectChains: [{href,hops,finalStatus}]}
  last_impressions  INT,     -- carried so a finding stays traffic-contextualized between runs
  UNIQUE (site_id, page)
);

CREATE INDEX IF NOT EXISTS idx_technical_seo_checks_rotation ON technical_seo_checks (site_id, checked_at ASC NULLS FIRST);
