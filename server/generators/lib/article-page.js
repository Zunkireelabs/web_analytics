// Whether a page is a blog post / article, decided from the page's OWN declarations (og:type, Article-family schema or an article URL
// segment — page-content.js's isArticleLikePage), never guessed from the generator. Used by the Quality Gate so a per-site word ban can
// exempt blog posts no matter which generator is editing one.
//
// Fails CLOSED: a page that cannot be read is treated as NOT an article, so the ban still applies. Cached briefly because the gate runs
// several times per draft (each generation attempt, each repair, then approval).
//
// Two signals, in this order:
//   1. The site's OWN declaration of where its blog posts live (url_file_map.newContentTargets['blog-outline'].urlPattern, e.g. "/blogs/{slug}").
//      This needs no fetch, so it also works for a post that is drafted but not published yet — the page does not exist to be read.
//   2. The live page's own declarations (og:type, Article-family schema, an article URL segment).
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const cache = new Map();

export function _resetArticlePageCacheForTest() { cache.clear(); }

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "/blogs/{slug}" -> /^\/blogs\/[^/]+\/?$/ . Only the blog generator's target counts: a landing page's "/{slug}" pattern would match every page.
export function siteArticleUrlRegexes(site) {
  const pattern = site?.url_file_map?.newContentTargets?.['blog-outline']?.urlPattern;
  if (typeof pattern !== 'string' || !pattern.includes('{slug}')) return [];
  const body = pattern.split('{slug}').map(escapeRe).join('[^/]+');
  // A bare "/{slug}" would match every page on the site, so a blog pattern must have a fixed prefix.
  if (!/[a-z0-9]/i.test(pattern.split('{slug}')[0])) return [];
  try { return [new RegExp(`^${body.replace(/\/+$/, '')}/?$`, 'i')]; } catch { return []; }
}

export function matchesSiteArticleUrl(page, site) {
  if (!page || typeof page !== 'string') return false;
  let path;
  try { path = new URL(page).pathname; } catch { path = page; }
  return siteArticleUrlRegexes(site).some((re) => re.test(path));
}

export async function isArticlePageUrl(page, { analyze = null, now = Date.now(), site = null } = {}) {
  if (!page || typeof page !== 'string') return false;
  if (matchesSiteArticleUrl(page, site)) return true;
  const hit = cache.get(page);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value = false;
  try {
    const fn = analyze || (await import('../../agents/lib/page-content.js')).analyzePageUrl;
    const res = await fn(page);
    value = Boolean(res?.ok && res.analysis?.isArticlePage);
  } catch { value = false; }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(page, { value, at: now });
  return value;
}
