import * as cheerio from 'cheerio';

// Live-fetches a landing page and checks what's actually on it, so the
// Opportunity Agent's recommendations are grounded in the real page instead
// of guessed from ranking signals alone. One fetch per unique page URL per
// agent run (callers should cache across queries that share a landing page).

const FETCH_TIMEOUT_MS = 5000;
const MIN_META_DESCRIPTION_LEN = 50;
const MAX_META_DESCRIPTION_LEN = 160;
const MIN_INTERNAL_LINKS = 3;
const MIN_WORD_COUNT = 300;
// Standard SERP-snippet-width-derived range — below this a title is usually
// thin/generic, above it Google truncates the displayed title in results.
const MIN_TITLE_LEN = 30;
const MAX_TITLE_LEN = 60;

// String-level guard against fetching a private/local address — every page
// this module fetches ultimately comes from real, external data (a site's
// own GSC page URL, or an LLM-named competitor domain), but nothing
// previously stopped a same-host redirect from resolving somewhere like
// 169.254.169.254 (cloud metadata) or localhost. Not a full SSRF defense
// (doesn't catch DNS rebinding — the hostname string can look public while
// resolving to a private IP at connect time), but blocks the common,
// cheap case. Exported so the technical-seo redirect-chain follower
// (server/agents/lib/technical-seo-analysis.js) applies the same check to
// every hop, not just the first request.
const PRIVATE_HOSTNAME_PATTERNS = [/^localhost$/i, /\.local$/i, /\.internal$/i];
export function isPrivateOrLocalHost(hostname) {
  if (!hostname) return true;
  if (PRIVATE_HOSTNAME_PATTERNS.some((re) => re.test(hostname))) return true;
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1, 3).map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const v6 = hostname.replace(/^\[|\]$/g, '');
  if (v6 === '::1' || /^fe80:/i.test(v6) || /^f[cd][0-9a-f]{2}:/i.test(v6)) return true;
  return false;
}

async function fetchHtml(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return { ok: false, error: 'invalid URL' }; }
  if (isPrivateOrLocalHost(hostname)) return { ok: false, error: 'blocked: private/local address' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +opportunity-agent)' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    // Harmless when every caller only ever passes a known page URL (from
    // GSC), but the site-wide crawler (site-discovery.js) follows arbitrary
    // discovered hrefs — some of which are PDFs/images/etc, not HTML —
    // and cheerio parsing binary content as HTML is a waste at best.
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('html')) return { ok: false, error: `not HTML: ${contentType || 'unknown content-type'}` };
    return { ok: true, html: await res.text() };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(timeout);
  }
}

function analyzePage(html, pageUrl) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const metaDescription = ($('meta[name="description"]').attr('content') || '').trim();
  const headingText = $('h1, h2, h3').text();

  const schemaTypes = new Set();
  let hasFaqSchema = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const types = [].concat(item['@type'] || [], (item['@graph'] || []).map((g) => g['@type']) || []).flat();
        types.forEach((t) => t && schemaTypes.add(t));
        if (types.includes('FAQPage')) hasFaqSchema = true;
      }
    } catch { /* malformed JSON-LD on the page — ignore that block */ }
  });
  const hasAnySchema = schemaTypes.size > 0;
  const hasFaqHeading = /faq|frequently asked questions/i.test(headingText);

  let host = null;
  try { host = new URL(pageUrl).hostname; } catch { /* leave host null */ }
  // Every real internal href, resolved to an absolute URL — one entry per
  // matching anchor tag (not deduped; a page linking the same URL 5 times
  // still contributes 5 entries here, same as internalLinkCount always
  // counted before this change — dedup is the crawler's job, not this
  // function's). Used by the technical-seo agent's broken-link/redirect-
  // chain crawl (server/agents/lib/technical-seo-analysis.js). Always
  // resolves via `new URL(href, pageUrl)` and checks the real hostname,
  // rather than the previous shortcut of trusting any href starting with
  // '/' — that shortcut incorrectly counted protocol-relative external
  // links (e.g. "//evil.com/x", which also starts with '/') as internal.
  const internalLinks = [];
  const internalLinkCount = host
    ? $('a[href]').filter((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#')) return false;
      let resolved;
      try { resolved = new URL(href, pageUrl); } catch { return false; }
      if (resolved.hostname !== host) return false;
      internalLinks.push(resolved.href);
      return true;
    }).length
    : 0;

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').filter(Boolean).length : 0;

  const images = $('img');
  const imagesWithoutAlt = images.filter((_, el) => !($(el).attr('alt') || '').trim()).length;

  const hasComparisonTable = $('table').filter((_, el) => /\bvs\.?\b|\bversus\b|\bcomparison\b/i.test($(el).text())).length > 0;
  const hasComparisonHeading = /\bvs\.?\b|\bversus\b|\bcompar(e|ison)\b/i.test(headingText);

  return {
    title,
    metaDescription, // raw text — hasMetaDescription below is the boolean other callers already rely on
    hasMetaDescription: metaDescription.length >= MIN_META_DESCRIPTION_LEN,
    hasSchema: hasAnySchema,
    schemaTypes: [...schemaTypes],
    hasFaq: hasFaqSchema || hasFaqHeading,
    hasFaqSchema, // split out from hasFaq — FAQPage schema is a stronger, machine-readable signal than a heading
    hasFaqHeading,
    hasComparisonContent: hasComparisonTable || hasComparisonHeading,
    h1Count: $('h1').length,
    h2Count: $('h2').length,
    questionHeadingCount: $('h1, h2, h3').filter((_, el) => /\?\s*$/.test($(el).text().trim())).length,
    imagesTotal: images.length,
    imagesWithoutAlt,
    hasCanonical: $('link[rel="canonical"]').length > 0,
    hasOpenGraph: $('meta[property="og:title"]').length > 0 || $('meta[property="og:description"]').length > 0,
    listCount: $('ul, ol').length,
    tableCount: $('table').length,
    internalLinkCount,
    internalLinks, // transient, like bodyText — real hrefs for the technical-seo crawler, not meant for persisted facts on other callers
    wordCount,
    bodyText, // transient — callers should not persist this into stored facts (used only for LLM context)
  };
}

// Known AI-crawler user-agent tokens checked against robots.txt. Not
// exhaustive, but covers the major LLM/answer-engine crawlers as of today.
const AI_CRAWLER_AGENTS = ['GPTBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider'];

// Simplified robots.txt scan (line-based, not a full RFC 9309 parser): for
// each known AI-crawler user-agent block, treat a bare "Disallow: /" as
// fully blocking that crawler. Anything more specific (partial paths) is
// not evaluated — this only answers "is this bot flatly disallowed site-wide".
function robotsAllowsAiCrawlers(robotsTxt) {
  const lines = robotsTxt.split('\n').map((l) => l.trim());
  let currentAgents = [];
  let blockedAny = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      currentAgents = [value];
    } else if (key === 'disallow' && value === '/') {
      if (currentAgents.some((a) => a === '*' || AI_CRAWLER_AGENTS.some((bot) => bot.toLowerCase() === a.toLowerCase()))) {
        blockedAny = true;
      }
    }
  }
  return !blockedAny;
}

// Exported for reuse by site-discovery.js (fetching robots.txt for crawl
// politeness, and each sitemap path) — same generic "fetch text from a URL,
// honestly report if it doesn't exist" shape those need, rather than a
// third copy of this fetch-with-timeout-and-guard boilerplate.
export async function fetchTextIfExists(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return { ok: false }; }
  if (isPrivateOrLocalHost(hostname)) return { ok: false };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0)' } });
    if (!res.ok) return { ok: false };
    return { ok: true, text: await res.text() };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

// Site-level (not per-page) AI-crawler readiness: does /llms.txt exist, and
// does /robots.txt avoid flatly blocking major AI crawlers. Fetched once per
// agent run against the site's own root domain.
export async function checkLlmsReadiness(origin) {
  const [llms, robots] = await Promise.all([
    fetchTextIfExists(`${origin}/llms.txt`),
    fetchTextIfExists(`${origin}/robots.txt`),
  ]);
  return {
    hasLlmsTxt: llms.ok,
    hasRobotsTxt: robots.ok,
    robotsAllowsAiCrawlers: robots.ok ? robotsAllowsAiCrawlers(robots.text) : null, // null = robots.txt not found, inconclusive
  };
}

function recommendActions(analysis, query) {
  const tags = [];
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const titleHasQuery = queryTerms.length > 0 && queryTerms.some((t) => analysis.title.toLowerCase().includes(t));
  if (!titleHasQuery) tags.push('Improve title');
  if (!analysis.hasMetaDescription) tags.push('Improve meta');
  if (!analysis.hasFaq) tags.push('Add FAQ');
  if (!analysis.hasSchema) tags.push('Add schema');
  if (analysis.internalLinkCount < MIN_INTERNAL_LINKS) tags.push('Add internal links');
  if (analysis.wordCount < MIN_WORD_COUNT) tags.push('Expand content');
  return tags;
}

// Exact tag -> generator map, source of truth for the finite vocabulary
// `recommendActions()`/`contentGapChecks()` produce. Replaces the old
// downstream substring-guessing (mapToGenerator in action-center.js): every
// agent that emits one of these tags sets `recommendedAction.generatorId`
// directly from here instead of a caller re-inferring it from free text —
// so a recommendation can never silently vanish because wording didn't
// match a keyword. `null` = a real, worthwhile finding with no matching
// generator today (e.g. "expand content" has no draft-generation flow) —
// left null rather than forced onto a generator that doesn't fit.
export const TAG_TO_GENERATOR = {
  'Improve title': 'meta-title',
  'Improve meta': 'meta-title',
  'Add FAQ': 'faq',
  'Add schema': 'schema',
  'Add internal links': 'internal-links',
  'Expand content': null,
};

export const GAP_TYPE_TO_GENERATOR = {
  'Missing FAQ': 'faq',
  'Missing schema': 'schema',
  'Missing headings': null,
  'Missing comparisons': null,
  'Missing alt text': null,
  'Missing canonical tag': null,
  'Missing Open Graph tags': null,
  'Missing structured lists': null,
  'Missing question-style headings': null,
  'Title length': 'meta-title',
  'Meta description length': 'meta-title',
};

// Effort is a property of the action itself (structural config fix vs
// net-new content), not of how important the finding is — kept as one
// honest, documented lookup instead of a per-agent guessed constant.
const GENERATOR_EFFORT = {
  'meta-title': 'Low', faq: 'Low', schema: 'Low', 'internal-links': 'Low', 'llms-txt': 'Low',
  'blog-outline': 'High', 'landing-page': 'High', translation: 'High',
};
export const effortForGenerator = (generatorId) => GENERATOR_EFFORT[generatorId] || 'Medium';

// Best-effort schema type for an "Add schema markup" recommendation — never
// blindly 'Article'. Prefers a real signal already on the page (an existing
// JSON-LD @type from analyzePage's schemaTypes, even if incomplete/partial)
// over a URL-path guess, and only falls back to 'Article' when neither applies.
// Boilerplate types (site-wide Organization/WebSite/BreadcrumbList markup)
// are skipped since they say nothing about this specific page's content type.
const BOILERPLATE_SCHEMA_TYPES = new Set(['Organization', 'WebSite', 'BreadcrumbList', 'WebPage']);
const PATH_SCHEMA_HINTS = [
  [/\/(products?|shop|store)\//i, 'Product'],
  [/\/(faq|faqs)(\/|$)/i, 'FAQPage'],
  [/\/(contact|contact-us)(\/|$)/i, 'ContactPage'],
  [/\/(about|about-us|company)(\/|$)/i, 'AboutPage'],
  [/\/(blog|articles?|news)\//i, 'Article'],
];
export function inferSchemaType(pageUrl, schemaTypes = []) {
  const existing = (schemaTypes || []).find((t) => t && !BOILERPLATE_SCHEMA_TYPES.has(t));
  if (existing) return existing;
  let path = '';
  try { path = new URL(pageUrl).pathname; } catch { /* leave path empty, fall through to default */ }
  for (const [re, type] of PATH_SCHEMA_HINTS) if (re.test(path)) return type;
  return 'Article';
}

// Deterministic on-page completeness gaps for the Content Gap Agent — every
// item here is verified directly from the page's real fetched HTML (unlike
// the AI-inferred entity suggestions the agent adds separately). `queryTexts`
// gates the comparison check: a comparison section is only "missing" if ANY
// of the page's real top ranking queries signals comparison intent — not
// just the single #1 query, since comparison intent often shows up further
// down the page's own query list (e.g. #1 is a brand query, #2 is "x vs y").
function contentGapChecks(analysis, queryTexts = []) {
  const queries = Array.isArray(queryTexts) ? queryTexts : [queryTexts];
  const gaps = [];
  if (analysis.h1Count === 0) gaps.push({ type: 'Missing headings', detail: 'No H1 heading found.' });
  else if (analysis.h1Count > 1) gaps.push({ type: 'Missing headings', detail: `${analysis.h1Count} H1 tags found — should be exactly one.` });
  if (analysis.h2Count === 0) gaps.push({ type: 'Missing headings', detail: 'No H2 subheadings — thin content structure.' });

  if (!analysis.hasFaq) gaps.push({ type: 'Missing FAQ', detail: 'No FAQ schema or FAQ heading detected.' });
  if (!analysis.hasSchema) gaps.push({ type: 'Missing schema', detail: 'No structured data (JSON-LD) found on the page.' });

  const titleLen = analysis.title?.length || 0;
  if (titleLen === 0) gaps.push({ type: 'Title length', detail: 'No <title> tag content found.' });
  else if (titleLen < MIN_TITLE_LEN) gaps.push({ type: 'Title length', detail: `Title is ${titleLen} characters — usually too short/generic (target ${MIN_TITLE_LEN}-${MAX_TITLE_LEN}).` });
  else if (titleLen > MAX_TITLE_LEN) gaps.push({ type: 'Title length', detail: `Title is ${titleLen} characters — Google typically truncates past ${MAX_TITLE_LEN}.` });

  if (analysis.hasMetaDescription) {
    const descLen = analysis.metaDescription.length;
    if (descLen > MAX_META_DESCRIPTION_LEN) gaps.push({ type: 'Meta description length', detail: `Meta description is ${descLen} characters — Google typically truncates past ${MAX_META_DESCRIPTION_LEN}.` });
  }

  const comparisonQuery = queries.find((q) => /\bvs\.?\b|\bversus\b|\bcompar(e|ison)\b|\bbest\b/i.test(q));
  if (comparisonQuery && !analysis.hasComparisonContent) {
    gaps.push({ type: 'Missing comparisons', detail: `Ranking query "${comparisonQuery}" signals comparison intent, but no comparison table or section was found.` });
  }

  if (analysis.imagesTotal > 0 && analysis.imagesWithoutAlt > 0) {
    gaps.push({ type: 'Missing alt text', detail: `${analysis.imagesWithoutAlt}/${analysis.imagesTotal} images have no alt text.` });
  }
  if (!analysis.hasCanonical) gaps.push({ type: 'Missing canonical tag', detail: 'No rel="canonical" link found.' });
  if (!analysis.hasOpenGraph) gaps.push({ type: 'Missing Open Graph tags', detail: 'No og:title/og:description found.' });
  if (analysis.listCount === 0) gaps.push({ type: 'Missing structured lists', detail: 'No ordered/unordered lists — lists help answer-engine extraction.' });
  if (analysis.questionHeadingCount === 0) gaps.push({ type: 'Missing question-style headings', detail: 'No headings phrased as questions — reduces AEO/featured-snippet eligibility.' });

  return gaps;
}

// Fetches and analyzes `url` once, returning a reusable base analysis. Pass
// the same result into recommendationsFor() for every query that lands on
// this page, so shared pages aren't re-fetched.
export async function analyzePageUrl(url) {
  const fetched = await fetchHtml(url);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  return { ok: true, analysis: analyzePage(fetched.html, url) };
}

// Query-specific recommendations (title match depends on the query) built
// from an already-fetched page's analysis.
export function recommendationsFor(analysis, query) {
  return recommendActions(analysis, query);
}

// Deterministic content-completeness gaps (headings/FAQ/schema/comparisons/
// alt-text/canonical/OG/lists/question-headings) for the Content Gap Agent.
// `queryTexts` is the page's list of real top ranking queries (comparison
// intent is checked across all of them, not just the #1 query).
export function contentGapsFor(analysis, queryTexts) {
  return contentGapChecks(analysis, queryTexts);
}
