// Detects real GSC pages/queries that almost certainly don't belong to this
// site at all — the classic "expired/acquired domain still carrying a prior
// owner's (often hacked) spam index" pattern, first found by hand on
// chayceproperties.com: GSC showed 1.5M+ un-indexed URLs built from
// `?h=<digits>` params and `/shop/…KeepCriteriaInput.aspx` paths (a legacy
// ASP.NET storefront this Eleventy site never had), with the top real query
// being an unrelated Arabic perfume term. Both checks are deterministic
// pattern-matching over data already ingested by server/ingest/gsc.js — no
// LLM guessing, since a false positive here drafts a Disallow rule against
// this site's own real traffic.

// Path extensions no modern JS-built site (every stack this platform
// onboards: Eleventy, Next.js, Astro, Hugo, plain static) legitimately
// serves — a hallmark of a different, often much older, platform's URLs
// still attached to this domain's crawl/index history.
const FOREIGN_PLATFORM_EXTENSIONS = /\.(aspx|jsp|cgi|do|action|php[3-7]?)(\?|$)/i;

// One short (1-2 char) query-param name holding a long (8+ digit) numeric
// value and nothing else — the exact shape of the `?h=8020347041280` spam-
// farm URLs found on Chayce, a common pattern for auto-generated junk pages.
function hasJunkNumericParam(pathname, search) {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const entries = [...params.entries()];
  if (entries.length !== 1) return null;
  const [key, value] = entries[0];
  if (key.length > 2) return null;
  if (!/^\d{8,}$/.test(value)) return null;
  return `${pathname}?${key}=*`;
}

// Plain boolean over a single URL, reusing the exact same two rules above —
// for callers that just need to keep a URL out of page_inventory or an
// agent's batch (site discovery, candidate-pages.js) rather than build a
// grouped-by-pattern report for a finding. Never used to delete/orphan
// anything on its own; see job.js and candidate-pages.js for how each
// caller actually applies it.
export function isForeignPlatformSpamUrl(pageUrl) {
  let url;
  try { url = new URL(pageUrl); } catch { return false; }
  if (FOREIGN_PLATFORM_EXTENSIONS.test(url.pathname)) return true;
  return Boolean(hasJunkNumericParam(url.pathname, url.search));
}

// pages: rows from getGscBreakdownRange(siteId, start, end, 'page', limit) —
// { dim_value, impressions, clicks, ... }. Returns one entry per distinct
// pattern found, each carrying real sample URLs (never fabricated) so the
// finding's evidence is checkable by a human.
export function detectSpamUrlPatterns(pages) {
  const byPattern = new Map();
  for (const row of pages) {
    let url;
    try { url = new URL(row.dim_value); } catch { continue; }
    let pattern = null;
    if (FOREIGN_PLATFORM_EXTENSIONS.test(url.pathname)) {
      // First real path segment as the blocked prefix (e.g. "/shop/*" for
      // "/shop/storeSearch/KeepCriteriaInput.aspx") — never the full,
      // per-URL path, since these come in enormous per-URL variety and a
      // shared prefix is what a real Disallow rule needs to be useful.
      const firstSegment = url.pathname.split('/').filter(Boolean)[0];
      pattern = firstSegment ? `/${firstSegment}/*` : `${url.pathname}*`;
    } else {
      pattern = hasJunkNumericParam(url.pathname, url.search);
    }
    if (!pattern) continue;
    const existing = byPattern.get(pattern) || { pattern, samplePages: [], impressions: 0 };
    if (existing.samplePages.length < 5) existing.samplePages.push(row.dim_value);
    existing.impressions += Number(row.impressions) || 0;
    byPattern.set(pattern, existing);
  }
  return [...byPattern.values()];
}

// Non-Latin scripts a query might legitimately use for a site whose own
// declared language_code (sites.language_code, migration 159) is one of
// them — this only flags a script inconsistent with what the site is
// actually supposed to be in, never non-English text in general.
const SCRIPT_RANGES = {
  ar: /[؀-ۿ]/, // Arabic
  zh: /[一-鿿]/, // CJK
  ja: /[぀-ヿ]/, // Hiragana/Katakana
  ko: /[가-힯]/, // Hangul
  ru: /[Ѐ-ӿ]/, // Cyrillic
  he: /[֐-׿]/, // Hebrew
  th: /[฀-๿]/, // Thai
};

// queries: rows from getGscBreakdownRange(siteId, start, end, 'query', limit)
// — { dim_value, impressions, ... }. languageCode: site.language_code.
export function detectForeignScriptQueries(queries, languageCode) {
  const expected = SCRIPT_RANGES[languageCode];
  const flagged = [];
  for (const row of queries) {
    const text = row.dim_value || '';
    for (const [script, re] of Object.entries(SCRIPT_RANGES)) {
      if (script === languageCode) continue;
      if (expected?.test(text)) continue; // matches the site's own declared script — not foreign
      if (re.test(text)) {
        flagged.push({ query: text, script, impressions: Number(row.impressions) || 0 });
        break;
      }
    }
  }
  return flagged;
}
