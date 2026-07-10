import * as cheerio from 'cheerio';

// Live-fetches a landing page and checks what's actually on it, so the
// Opportunity Agent's recommendations are grounded in the real page instead
// of guessed from ranking signals alone. One fetch per unique page URL per
// agent run (callers should cache across queries that share a landing page).

const FETCH_TIMEOUT_MS = 5000;
const MIN_META_DESCRIPTION_LEN = 50;
const MIN_INTERNAL_LINKS = 3;
const MIN_WORD_COUNT = 300;

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +opportunity-agent)' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
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
  const internalLinkCount = host
    ? $('a[href]').filter((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#')) return false;
      if (href.startsWith('/')) return true;
      try { return new URL(href, pageUrl).hostname === host; } catch { return false; }
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
    wordCount,
    bodyText, // transient — callers should not persist this into stored facts (used only for LLM context)
  };
}

// Known AI-crawler user-agent tokens checked against robots.txt. Not
// exhaustive, but covers the major LLM/answer-engine crawlers as of today.
const AI_CRAWLER_AGENTS = ['GPTBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'PerplexityBot', 'Google-Extended', 'CCBot', 'Bytespider'];

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

async function fetchTextIfExists(url) {
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
