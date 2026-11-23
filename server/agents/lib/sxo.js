// Search-experience (SXO) rules: is this page the right KIND of page for the search it is stuck on? A page can be technically perfect and
// still never break through when Google shows a different kind of page for that search (an article against a page of product listings),
// whatever its title or links. The idea and the mismatch table follow claude-seo's seo-sxo skill (MIT, (c) 2026 agricidaniel; skill by
// Florian Schmitz): classify each result on the results page, take the dominant type, compare it with the page's own type.
//
// Honest limits, stated here so no caller oversells it: a result's type is read from its address and title only (the pages are not
// fetched), so it is a strong hint, not a measurement; the skill's 8-type taxonomy is reduced to the five types those two signals can
// separate (article, comparison, product, service, tool); and the page's own type comes from the existing page classifier.
// Pure: results in, verdicts out.

export const SERP_TYPES = ['tool', 'comparison', 'product', 'service', 'article', 'other'];

const TOOL = /\b(calculator|generator|checker|converter|estimator|simulator|validator|analy[sz]er)\b/i;
const COMPARISON = /\bvs\.?\b|\bversus\b|\bcompar(e|ison|ing)\b|\balternatives?\b/i;
const PRODUCT_TITLE = /\b(buy|shop|price[sd]?|pricing|deals?|for sale|discount|cheap|order)\b|[$£€]\s?\d/i;
const PRODUCT_PATH = /\/(products?|shop|store|buy|p|item|collections?|category|catalog(ue)?)\//i;
const SERVICE_TITLE = /\b(services?|agency|company|consultants?|consulting|near me|get a quote|book (a|now)|hire|solutions)\b/i;
const SERVICE_PATH = /\/(services?|solutions|agency|consulting|contact|get-a-quote|hire)(\/|$)/i;
const ARTICLE_TITLE = /^\s*\d+\b|\b(best|top|how to|what (is|are)|why|guide|tips|ideas|examples|explained|step[- ]by[- ]step|ultimate|complete|checklist|mistakes)\b/i;
const ARTICLE_PATH = /\/(blog|news|articles?|guides?|resources?|learn|insights|posts?|magazine)\//i;

/** One result on the results page, from its address and title. */
export function classifyResultType({ url, title } = {}) {
  let path = '';
  try { path = new URL(url).pathname; } catch { /* a result with no usable address is judged on its title alone */ }
  const t = String(title || '');
  if (TOOL.test(t)) return 'tool';
  if (COMPARISON.test(t)) return 'comparison';
  if (PRODUCT_PATH.test(path) || (PRODUCT_TITLE.test(t) && !ARTICLE_TITLE.test(t))) return 'product';
  if (SERVICE_PATH.test(path) || (SERVICE_TITLE.test(t) && !ARTICLE_TITLE.test(t))) return 'service';
  if (ARTICLE_PATH.test(path) || ARTICLE_TITLE.test(t)) return 'article';
  return 'other';
}

/**
 * The type most of the top results share. "strong" needs 60% of the results that could be typed; below that the page type is not the
 * thing holding the page back (no verdict).
 */
export function serpConsensus(results) {
  const typed = (results || []).map((r) => ({ ...r, type: classifyResultType(r) }));
  const counts = Object.fromEntries(SERP_TYPES.map((t) => [t, 0]));
  for (const r of typed) counts[r.type] += 1;
  const known = typed.filter((r) => r.type !== 'other');
  const ranked = Object.entries(counts).filter(([t]) => t !== 'other').sort((a, b) => b[1] - a[1] || SERP_TYPES.indexOf(a[0]) - SERP_TYPES.indexOf(b[0]));
  const [dominant, n] = ranked[0] || ['other', 0];
  const share = known.length ? n / known.length : 0;
  return { dominant: n ? dominant : 'other', share: Math.round(share * 100) / 100, strong: known.length >= 5 && share >= 0.6, counts, typedCount: known.length, examples: typed.filter((r) => r.type === dominant).slice(0, 3).map((r) => ({ title: r.title, domain: r.domain })) };
}

/** The page classifier's types onto the five a result's address and title can show. Legal, utility and unknown pages are not judged. */
const OURS = { blog: 'article', faq: 'article', product: 'product', category: 'product', service: 'service', landing: 'service' };
export const ourPageKind = (contentType) => OURS[contentType] || null;

// [ours][serp dominant] -> severity and what to do. A missing pair is aligned or not worth a finding.
const MISMATCH = {
  article: {
    product: ['high', 'Google shows product and shop pages for this search. An article will rarely break through here, however good it is. A page where people can buy or order is what it is asking for.'],
    comparison: ['high', 'Google shows comparison pages for this search ("X vs Y", alternatives). Restructure this as a comparison, with a table of the options, or write a dedicated one.'],
    tool: ['high', 'Google shows tools and calculators for this search. People want to do something, not read about it. A tool on this page, or a dedicated one, is what it is asking for.'],
    service: ['medium', 'Google shows service pages for this search. Searchers want to hire someone; add a clear service offer and way to enquire, or build a dedicated service page.'],
  },
  service: {
    article: ['high', 'Google shows helpful articles and guides for this search, not sales pages. Searchers want an answer first. Add real, useful content to this page, or write a guide that links to it.'],
    comparison: ['medium', 'Google shows comparison pages for this search. A page that compares the options will fit it better than a pitch.'],
    product: ['medium', 'Google shows product pages for this search. Make it easy to see what is offered and what it costs, in the way those pages do.'],
    tool: ['medium', 'Google shows tools and calculators for this search. A tool on this page, or a dedicated one, would match what is asked for.'],
  },
  product: {
    article: ['high', 'Google shows articles and guides for this search, not product pages. Searchers are still learning. A helpful guide that links to the product will fit this search better.'],
    comparison: ['medium', 'Google shows comparison pages for this search. A comparison of the options will fit it better than a single product page.'],
    service: ['medium', 'Google shows service pages for this search. Make the service and how to enquire clear on this page.'],
    tool: ['medium', 'Google shows tools and calculators for this search. A tool would match what is asked for.'],
  },
};

/** @returns { severity: 'high'|'medium', advice } or null when the page type fits, or is not judged, or the results page is not clear */
export function judgeMismatch(oursKind, consensus) {
  if (!oursKind || !consensus?.strong) return null;
  const hit = MISMATCH[oursKind]?.[consensus.dominant];
  return hit ? { severity: hit[0], advice: hit[1] } : null;
}

/**
 * The pages worth checking: ranking on the edge of page one (8 to 20) for a search with real impressions, the strongest query per page,
 * most impressions first. A page already in the top 7 is not held back by its type; one beyond 20 is a different problem.
 * @param rows  [{ query, page, avgPosition, impressions }]
 */
export function findStrikingPairs(rows, { minPosition = 8, maxPosition = 20, minImpressions = 50, max = 5 } = {}) {
  const best = new Map();
  for (const r of rows || []) {
    const pos = Number(r.avgPosition); const imp = Number(r.impressions);
    if (!r.page || !r.query || !Number.isFinite(pos) || pos < minPosition || pos > maxPosition || imp < minImpressions) continue;
    const cur = best.get(r.page);
    if (!cur || imp > Number(cur.impressions)) best.set(r.page, { query: r.query, page: r.page, avgPosition: pos, impressions: imp });
  }
  return [...best.values()].sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page)).slice(0, max);
}
