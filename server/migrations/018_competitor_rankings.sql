-- Real competitor SERP rankings, fetched weekly (see ingest/competitors.js)
-- for a site's own top real GSC queries only — via a provider abstraction
-- (ingest/competitor-providers/), DataForSEO first. One row per
-- (site, date, query, domain) so the same query on the same date can list
-- multiple competing domains, including the site's own when it appears.
CREATE TABLE IF NOT EXISTS competitor_rankings (
  site_id       INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  query         TEXT NOT NULL,
  domain        TEXT NOT NULL,
  url           TEXT,
  position      INT NOT NULL,
  is_own_domain BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (site_id, date, query, domain)
);

CREATE INDEX IF NOT EXISTS idx_competitor_rankings_lookup ON competitor_rankings (site_id, query, date);
