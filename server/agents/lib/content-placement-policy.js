import { classifyPageType } from '../../design-agent/live-analysis/schema.js';

// WHERE GENERATED CONTENT MAY GO, and where it may never go.
//
// Two rules, both from how a real designed page breaks when they are ignored:
//
//   1. No expanded/Q&A/FAQ block on a listing, index, hub, product or home page. Those pages are built from designed
//      sections; a block of generated prose spliced under one of them is filler inside a layout that was never meant
//      to hold it. The page types that mean this are listed in NO_EXPANDED_CONTENT_TYPES below.
//   2. No comparison content on a real page. A comparison belongs in a blog post that IS a comparison, or on a
//      /compare/ page. On any other page the only correct output is ONE plain link to the matching compare page, and
//      when no such page exists the honest answer is to report that it is needed and write nothing.
//
// Checked here — before a generator is chosen — rather than inside a generator, for the same reason
// expand-content-structural-fit.js moved its check to generation time: a refusal after an LLM call has already run
// has cost real money and produced a draft that should never have existed.
//
// This module only decides placement. It judges no content and rewrites nothing.

// Page types whose layout is designed sections, not a prose body. 'other' is deliberately NOT here: it means
// About/Team/Contact-style pages, which classifyPageType's own comment describes as real full-bleed section pages —
// but those are also the pages a tenant most often legitimately expands, so they stay allowed and are governed by the
// structural-fit check instead.
const NO_EXPANDED_CONTENT_TYPES = new Set([
  'homepage',
  'blog-listing', // /blog/, /articles/, /resources/, /insights/ … the index, not a post
  'landing',
  'pricing', 'features', 'how-it-works', 'demo', 'case-study', // product-site section pages
]);

// 'service' and 'location' need the hub/detail distinction that classifyPageType does not draw: /products/ is a
// designed hub, while /products/teeth-whitening/ is a detail page with a real prose body and a legitimate place for an
// FAQ or an expanded section. Only the hub itself is refused.
const HUB_ONLY_TYPES = new Set(['service', 'location']);

// Extra URL shapes that are hub pages on a website tenant but are not covered by classifyPageType's rules.
// Same hub/detail distinction: /customers/ is a designed index, /customers/acme-case-study/ is a page with a body.
const HUB_PATH_RE = /^\/(customers?|clients?|team|people|projects?|portfolio|industries|partners?|testimonials?)\/?$/;

const GENERATORS_THAT_INSERT_BLOCKS = new Set(['expand-content', 'qa-content', 'faq']);

/**
 * May `generatorId` insert a block into `pageUrl`?
 *
 * Returns { allowed: true } or { allowed: false, reason, detail } — a refusal carries the page type it was judged on,
 * so it can be reported to a human rather than looking like the generator simply failed.
 */
export function mayInsertContentBlock(generatorId, pageUrl, { propertyType = null } = {}) {
  if (!GENERATORS_THAT_INSERT_BLOCKS.has(generatorId)) return { allowed: true };
  if (!pageUrl) return { allowed: true }; // no page to judge: the generator's own checks still apply

  const pageType = classifyPageType(pageUrl, { propertyType });
  let path = '';
  try { path = new URL(pageUrl).pathname.toLowerCase(); } catch { path = String(pageUrl).toLowerCase(); }

  const segments = path.split('/').filter(Boolean);
  const isHubRoot = segments.length <= 1;

  if (NO_EXPANDED_CONTENT_TYPES.has(pageType) || (HUB_ONLY_TYPES.has(pageType) && isHubRoot)) {
    return {
      allowed: false, pageType, reason: 'designed-section-page',
      detail: `${pageUrl} is a ${pageType} page: it is built from designed sections, so a generated ${generatorId} block would be filler inside a layout that cannot hold it. Expand a specific article or detail page instead.`,
    };
  }
  if (HUB_PATH_RE.test(path)) {
    return {
      allowed: false, pageType, reason: 'hub-page',
      detail: `${pageUrl} is a hub/index page, so a generated ${generatorId} block would sit under a designed section. Expand one of the pages it links to instead.`,
    };
  }
  return { allowed: true, pageType };
}

/**
 * May a COMPARISON be written into this page at all?
 *
 * This is the rule that keeps "X vs Y" out of a designed page. A comparison reads as a table or a side-by-side block;
 * inside an article that is itself about the comparison it belongs, and on any other page it is both a layout break
 * and a claim the page never earned. Separate from mayInsertContentBlock because a comparison is refused even on
 * pages that happily accept an ordinary expanded section (an About or a service detail page).
 *
 * Returns { allowed: true } only for a page whose own subject is the comparison.
 */
export function mayWriteComparisonInto(pageUrl, { propertyType = null } = {}) {
  if (!pageUrl) return { allowed: false, reason: 'unknown-page', detail: 'Without a target page a comparison cannot be placed; it belongs in a post about that comparison.' };
  const pageType = classifyPageType(pageUrl, { propertyType });
  if (pageType === 'blog-article') return { allowed: true, pageType };
  return {
    allowed: false, pageType, reason: 'comparison-off-page',
    detail: `${pageUrl} is a ${pageType} page, so a comparison must not be written into it. A comparison belongs in a post whose subject is that comparison, or on its own compare page; here the only correct output is one plain link to that page.`,
  };
}

/**
 * May comparison content be written on this page, and if not, what instead?
 *
 * Returns one of:
 *   { kind: 'inline' }                            a blog post that IS a comparison: write it as plain markdown
 *   { kind: 'link', comparePage }                 a real page with a matching compare page: ONE plain link, nothing copied
 *   { kind: 'report-missing', topic }             no compare page exists: report it and write nothing
 */
export function comparisonPlacement(pageUrl, { propertyType = null, topic = null, comparePages = [] } = {}) {
  const pageType = classifyPageType(pageUrl, { propertyType });
  // A blog post about a comparison is the one place the comparison itself belongs.
  if (pageType === 'blog-article') return { kind: 'inline', pageType };

  const match = matchComparePage(topic, comparePages);
  if (match) return { kind: 'link', comparePage: match, pageType };
  return { kind: 'report-missing', topic, pageType };
}

// Matches a topic to an existing compare page by the words they share. Deliberately literal: a near-miss would send a
// reader to a comparison that is not the one they searched for, which is worse than reporting the page as missing.
function matchComparePage(topic, comparePages) {
  const wanted = tokens(topic);
  if (!wanted.length) return null;
  let best = null;
  let bestScore = 0;
  for (const page of comparePages) {
    const url = typeof page === 'string' ? page : page?.url;
    if (!url) continue;
    const have = new Set(tokens(`${url} ${typeof page === 'object' ? (page.title || '') : ''}`));
    const score = wanted.filter((w) => have.has(w)).length / wanted.length;
    if (score > bestScore) { bestScore = score; best = url; }
  }
  return bestScore >= 0.6 ? best : null;
}

const tokens = (v) => String(v || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && w !== 'vs');

// Instruction text for a generator writing anything on any page: what it may not invent, and what it may not claim.
// Kept here beside the placement rules so a generator cannot be given one without the other.
export const CONTENT_FACT_RULES =
  'Only state what this site itself or a cited, named source says. Every statistic needs a named source and a link; '
  + 'if you cannot verify one, leave it out. Never make a claim about an unnamed competitor, and never compare this '
  + 'company with another one outside a page whose whole subject is that comparison.';
