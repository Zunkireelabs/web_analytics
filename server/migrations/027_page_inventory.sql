-- The canonical "every real page we know about" for a site — merges three
-- discovery sources (sitemap, a real homepage-outward crawl, and GSC's own
-- performance data) so page-level agents (ai-visibility, content-gap,
-- technical-seo) aren't limited to only pages that already have real search
-- traffic. See server/agents/lib/site-discovery.js.
--
-- Deliberately holds no content/audit data — purely "does this page exist
-- and how do we know" — so any current or future page-level agent can read
-- it without owning a schema slice, the same way competitor_profiles stays
-- agent-agnostic infrastructure rather than a findings table.
CREATE TABLE IF NOT EXISTS page_inventory (
  id              SERIAL PRIMARY KEY,
  site_id         INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page            TEXT NOT NULL,
  discovered_via  TEXT NOT NULL,   -- 'sitemap' | 'crawl' | 'gsc' — set once on first discovery, never overwritten
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, page)
);

CREATE INDEX IF NOT EXISTS idx_page_inventory_site ON page_inventory (site_id, last_seen_at DESC);

-- Generic per-agent rotation bookkeeping — lets ai-visibility.js and
-- content-gap.js each get the same bounded "check the least-recently-seen
-- pages first" rotation technical-seo.js already proved (technical_seo_checks,
-- migration 026), WITHOUT forcing them onto that table's technical-seo-
-- specific result columns. technical-seo.js keeps using its own table
-- exclusively — this is only for agents that previously had zero per-page
-- persistence at all.
CREATE TABLE IF NOT EXISTS agent_page_rotation (
  site_id     INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  page        TEXT NOT NULL,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, agent_id, page)
);

CREATE INDEX IF NOT EXISTS idx_agent_page_rotation_lookup ON agent_page_rotation (site_id, agent_id, checked_at ASC NULLS FIRST);
