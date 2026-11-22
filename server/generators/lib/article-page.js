// Whether a page is a blog post / article, decided from the page's OWN declarations (og:type, Article-family schema or an article URL
// segment — page-content.js's isArticleLikePage), never guessed from the generator. Used by the Quality Gate so a per-site word ban can
// exempt blog posts no matter which generator is editing one.
//
// Fails CLOSED: a page that cannot be read is treated as NOT an article, so the ban still applies. Cached briefly because the gate runs
// several times per draft (each generation attempt, each repair, then approval).
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const cache = new Map();

export function _resetArticlePageCacheForTest() { cache.clear(); }

export async function isArticlePageUrl(page, { analyze = null, now = Date.now() } = {}) {
  if (!page || typeof page !== 'string') return false;
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
