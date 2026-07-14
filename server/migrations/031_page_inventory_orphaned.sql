-- Real orphaned-page signal: true when a page is listed in the site's own
-- sitemap but the homepage-outward crawl (site-discovery.js's crawlSite)
-- never reached it via any real internal link — the standard SEO
-- definition of "orphaned." Recomputed from that same run's two already-
-- fetched lists (sitemapUrls vs crawledUrls) each time weekly discovery
-- runs — no new fetching, a pure comparison of real data already collected.
ALTER TABLE page_inventory ADD COLUMN IF NOT EXISTS orphaned BOOLEAN NOT NULL DEFAULT false;
