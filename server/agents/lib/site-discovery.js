import * as cheerio from 'cheerio';
import { fetchTextIfExists, isPrivateOrLocalHost, analyzePageUrl } from './page-content.js';
import { listSitemaps } from '../../ingest/gsc-technical.js';

// Real site-wide page discovery — so ai-visibility/content-gap/technical-seo
// aren't limited to only pages that already have GSC search traffic. Two
// sources feed one canonical inventory (server/store/page-inventory.js):
// the site's own sitemap(s), and (site-discovery.js's BFS crawl, added
// alongside this) a real homepage-outward link crawl. A third source, GSC's
// own top pages, is folded in by the caller (job.js's weekly discovery run)
// rather than here, since that data is already fetched elsewhere.

const MAX_SITEMAP_URLS = 5000;

function originForSite(site) {
  const property = site?.gsc_property || '';
  const url = property.startsWith('sc-domain:') ? `https://${property.slice('sc-domain:'.length)}` : property;
  try { return new URL(url).origin; } catch { return null; }
}

// Fetches and parses one sitemap (or sitemap index) directly — GSC's
// Sitemaps API (ingest/gsc-technical.js's listSitemaps) only reports
// metadata (path, error/warning counts), never the actual URL list inside,
// so this fetches the real file. Recurses into a sitemap index exactly one
// level regardless of what a child sitemap claims about itself, to bound
// worst-case fan-out.
async function fetchSitemapUrls(path, depth = 0) {
  let hostname;
  try { hostname = new URL(path).hostname; } catch { return []; }
  if (isPrivateOrLocalHost(hostname)) return [];

  const fetched = await fetchTextIfExists(path);
  if (!fetched.ok) return [];

  const $ = cheerio.load(fetched.text, { xmlMode: true });
  const isIndex = $('sitemapindex').length > 0;

  if (isIndex) {
    if (depth >= 1) return []; // one level of recursion only, hard stop
    const childPaths = $('sitemapindex > sitemap > loc').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const children = await Promise.all(childPaths.map((p) => fetchSitemapUrls(p, depth + 1)));
    return children.flat();
  }

  return $('urlset > url > loc').map((_, el) => $(el).text().trim()).get().filter(Boolean);
}

// Every real URL from every sitemap GSC knows about for this site, deduped,
// bounded at MAX_SITEMAP_URLS so a pathological sitemap can't blow up
// memory or the resulting DB writes.
export async function discoverFromSitemaps(site) {
  const sitemapResult = await listSitemaps(site);
  if (!sitemapResult.ok || !sitemapResult.sitemaps.length) return [];

  const perSitemap = await Promise.all(sitemapResult.sitemaps.map((s) => fetchSitemapUrls(s.path)));
  const urls = [...new Set(perSitemap.flat())];
  return urls.slice(0, MAX_SITEMAP_URLS);
}

const MAX_CRAWL_PAGES = 300;
const MAX_CRAWL_DEPTH = 4;
const CRAWL_CONCURRENCY = 5; // small concurrent chunks, not serial and not unbounded — politeness

export { MAX_CRAWL_PAGES, MAX_CRAWL_DEPTH, CRAWL_CONCURRENCY };

// A real, good-faith robots.txt Disallow/Allow parser for the crawler's own
// politeness — deliberately separate from page-content.js's
// robotsAllowsAiCrawlers, which only checks a blanket "/" block for named
// AI-crawler user-agents and explicitly does not evaluate partial paths.
// This one does real path-prefix matching (longest match wins, same
// precedence RFC 9309 defines) against the `User-agent: *` block only —
// this crawler doesn't need a named identity, just to respect the same
// rules any generic bot would. Like robotsAllowsAiCrawlers, this is a
// good-faith line-based scanner, not a byte-perfect spec implementation.
export function parseRobotsDisallowRules(robotsTxt) {
  const lines = (robotsTxt || '').split('\n').map((l) => l.trim());
  const rules = [];
  let currentAgents = [];
  let blockHasRules = false; // a Disallow/Allow line closes the current agent-line run; the next User-agent starts a new block

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (blockHasRules) { currentAgents = []; blockHasRules = false; }
      currentAgents.push(value);
    } else if (key === 'disallow' || key === 'allow') {
      blockHasRules = true;
      if (currentAgents.includes('*') && value) rules.push({ type: key, path: value });
    }
  }

  function longestMatch(path) {
    let best = null;
    for (const r of rules) {
      if (path.startsWith(r.path) && (!best || r.path.length > best.path.length)) best = r;
    }
    return best;
  }

  return {
    isAllowed(path) {
      const best = longestMatch(path);
      return !best || best.type === 'allow';
    },
    // The specific Disallow rule (if any) actually winning for this path —
    // used by technical-seo.js's robots-blocked finding to ground a
    // draftable Allow-override at the real offending pattern, not a guess.
    // null when the path is allowed (no winning disallow rule).
    matchingDisallow(path) {
      const best = longestMatch(path);
      return best && best.type === 'disallow' ? best.path : null;
    },
  };
}

// Real homepage-outward BFS crawl, reusing analyzePageUrl (page-content.js)
// per page — its analysis.internalLinks is exactly the crawl frontier.
// Bounded (maxPages/maxDepth), deduped at enqueue time (not just fetch time,
// to prevent loops), fetched in small concurrent chunks. A URL robots.txt
// disallows is still recorded as a known page (a real link pointed at it)
// but never fetched or expanded further — respects politeness without
// losing the fact that the URL exists.
//
// Caps are caller-supplied options, defaulting to the original weekly-
// discovery constants (MAX_CRAWL_PAGES/MAX_CRAWL_DEPTH/CRAWL_CONCURRENCY) so
// runSiteDiscoveryIfDue (job.js) is completely unaffected — bulk-audit.js's
// Full Site Audit is the caller that raises maxPages for exhaustive coverage
// while keeping concurrency at the same polite default regardless of site
// size (raise the page ceiling, not the request rate).
export async function crawlSite(site, { maxPages = MAX_CRAWL_PAGES, maxDepth = MAX_CRAWL_DEPTH, concurrency = CRAWL_CONCURRENCY } = {}) {
  const origin = originForSite(site);
  if (!origin) return [];

  const robotsFetch = await fetchTextIfExists(`${origin}/robots.txt`);
  const robots = parseRobotsDisallowRules(robotsFetch.ok ? robotsFetch.text : '');

  const discovered = new Set();
  const visited = new Set([origin]);
  let frontier = [{ url: origin, depth: 0 }];

  while (frontier.length && discovered.size < maxPages) {
    const batch = frontier.splice(0, concurrency);
    const nextFrontier = [];

    await Promise.all(batch.map(async ({ url, depth }) => {
      discovered.add(url);
      let path;
      try { path = new URL(url).pathname; } catch { return; }
      if (!robots.isAllowed(path)) return; // known, but not crawled further

      const fetched = await analyzePageUrl(url);
      if (!fetched.ok || depth >= maxDepth) return;

      for (const href of fetched.analysis.internalLinks || []) {
        if (visited.has(href) || visited.size >= maxPages) continue;
        visited.add(href);
        nextFrontier.push({ url: href, depth: depth + 1 });
      }
    }));

    frontier.push(...nextFrontier);
  }

  return [...discovered];
}

export { originForSite };
