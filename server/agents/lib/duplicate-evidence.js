// Shared evidence-gathering for every "which URL among a group of
// candidates is the real one" detector (url-variant-duplicates.js,
// query-param-duplicates.js, templated-duplicates.js) — factored out once
// three near-identical copies of the same 90-day-traffic winner logic
// existed. Two confidence tiers, both evidence-driven, never a guess:
//
//   HIGH   — exactly one candidate has ANY real clicks/impressions and
//            every other candidate has NONE. The cleanest possible signal:
//            one side earns real traffic, the other earns nothing.
//   MEDIUM-escalated-to-HIGH — two or more candidates each earn real,
//            independent traffic (originally left as a human decision,
//            since picking by "bigger share" would be exactly the kind of
//            appearance-based guess this platform refuses to make) — but
//            when EVERY pair of those candidates' real search queries
//            overlaps substantially, that's a second, independent signal
//            confirming they compete for the SAME user intent, not just
//            the same URL shape. Only then does the traffic leader (a
//            real, non-tied margin) become the evidenced winner.
//
// Never removes the MEDIUM tier itself — low/no query overlap, a tied
// margin, or missing query evidence for either side all still leave the
// finding exactly where it was: a human decision, now with richer
// evidence attached either way.
//
// SPLIT-TRAFFIC ESCALATION (2026-09-17) — per platform policy, an ambiguous
// query-overlap result is no longer the end of the line. When 2+ candidates
// each earn real, independent traffic and query overlap alone can't pick a
// winner, decideWinner now also weighs whatever of these OPTIONAL signals
// the caller has cheaply available (never a new fetch/paid API call just to
// obtain them — every one of these is either already computed by the
// calling agent for another reason, or free/deterministic):
//
//   canonicalByPage      — { page: resolvedCanonicalUrl|null }. If every
//                           OTHER candidate's own canonical tag already
//                           agrees on ONE target among the group, that
//                           target wins outright — the site has already
//                           told search engines which URL is authoritative.
//   pagePurposeByPage     — { page: contentType }. A closed vocabulary
//                           (page-content-classifier.js's CONTENT_TYPES).
//                           If the traffic-bearing candidates carry
//                           genuinely DIFFERENT declared/inferred purposes,
//                           that's a signal the pages serve different
//                           intents and should be LEFT ALONE, not merged —
//                           never used to force a merge.
//   functionalParamPages  — Set<page> of candidates whose query string
//                           carries a likely-FUNCTIONAL parameter (see
//                           isLikelyFunctionalQueryParam below) rather than
//                           pure tracking noise. Presence on ANY
//                           traffic-bearing candidate blocks a
//                           consolidate/redirect decision for that
//                           candidate — a functional parameter changes real
//                           visitor behavior, so collapsing it away is
//                           never safe regardless of how the traffic split.
//   internalLinkCountByPage — { page: count }. Used only as a supporting
//                           tiebreaker alongside a real (non-tied) click
//                           margin — never sufficient on its own to
//                           pick a winner from a tied click count, same
//                           discipline the existing tied-margin guard uses.
//   contentSimilarity     — a single 0..1 score for the WHOLE candidate set
//                           (e.g. from Jaccard word-overlap of already-
//                           fetched body text). High similarity (>= 0.7)
//                           supports treating a real click-margin winner as
//                           evidenced even without query-overlap
//                           confirmation; low similarity (< 0.3) among
//                           traffic-bearing candidates is itself a
//                           "these aren't really the same content" signal
//                           and pushes toward leave-both.
//
// The result gains a `decision` field describing what was actually decided
// beyond the raw confidence tier: 'consolidate' (winner set, safe to
// canonicalize), 'leave-both-independent-intent' (actively decided — not
// merely punted — because purposes differ or a functional param blocks it),
// or null (confidence stayed medium/low with no additional signal available
// — genuinely inconclusive, still a human reportOnly decision). `decision`
// is never 'consolidate' without `winner` also being set.

import { getSearchPerformanceForPages, getQueryPageMetrics } from '../../store/read.js';
import { daysAgoInTz } from '../../util/dates.js';

// Long enough that a genuine zero is real evidence, not a quiet week —
// every daily-battery run (job.js's DAILY_AGENT_IDS) otherwise only sees a
// 7-day window, far too short/noisy for "this variant gets zero real
// traffic" to be trustworthy.
export const EVIDENCE_LOOKBACK_DAYS = 90;

export function evidenceWindow(site) {
  return {
    start: daysAgoInTz(site.timezone || 'UTC', EVIDENCE_LOOKBACK_DAYS),
    end: daysAgoInTz(site.timezone || 'UTC', 0),
  };
}

export async function fetchTraffic(siteId, pages, start, end) {
  if (!pages.length) return [];
  const rows = await getSearchPerformanceForPages(siteId, start, end, pages);
  const byPage = new Map(rows.map((r) => [r.dim_value, { clicks: Number(r.clicks) || 0, impressions: Number(r.impressions) || 0 }]));
  return pages.map((p) => ({ page: p, ...(byPage.get(p) || { clicks: 0, impressions: 0 }) }));
}

// A single shared query with real impressions is coincidence; this floor
// (a real minimum shared-query COUNT, not just a ratio) is what keeps two
// pages that each rank for one stray overlapping term from reading as
// "the same intent." The ratio (against the SMALLER side's query set, not
// the union) is what keeps a page with many long-tail queries from being
// unfairly penalized for a smaller variant only ranking for a subset of
// them — subset containment is exactly the shape "these compete for the
// same demand" evidence takes.
const MIN_SHARED_QUERIES = 3;
const MIN_OVERLAP_RATIO = 0.6;
const QUERY_MIN_IMPRESSIONS = 1;

export async function fetchQuerySets(siteId, pages, start, end) {
  const rows = await getQueryPageMetrics(siteId, start, end, { minImpressions: QUERY_MIN_IMPRESSIONS });
  const byPage = new Map(pages.map((p) => [p, new Set()]));
  for (const row of rows) {
    if (byPage.has(row.page)) byPage.get(row.page).add(row.query);
  }
  return byPage;
}

// True only when EVERY pair among `pages` overlaps substantially — one
// strongly-overlapping pair can never carry a third, unrelated page along
// with it. False (never a guess) when either side of any pair has no real
// query evidence at all — absence of query data isn't evidence of overlap.
export function allPairsOverlapSubstantially(querySetsByPage, pages) {
  if (pages.length < 2) return false;
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = querySetsByPage.get(pages[i]) || new Set();
      const b = querySetsByPage.get(pages[j]) || new Set();
      if (a.size === 0 || b.size === 0) return false;
      const shared = [...a].filter((q) => b.has(q));
      const ratio = shared.length / Math.min(a.size, b.size);
      if (shared.length < MIN_SHARED_QUERIES || ratio < MIN_OVERLAP_RATIO) return false;
    }
  }
  return true;
}

// Well-known tracking/analytics parameter names — presence of ONLY these
// (and nothing else) on a URL is pure noise with no behavioral effect, so
// they never block a consolidate decision. Anything NOT on this list is
// treated as potentially functional — the safe default, since the cost of
// wrongly treating a real tracking param as functional is just "stays
// leave-both a bit more often," while the cost of wrongly treating a real
// functional param (pagination, filters, a package/variant selector — the
// chayceproperties.com `?package=` incident this file's sibling agents
// already document) as pure noise is a broken real visitor flow.
const KNOWN_TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'dclid', 'twclid', 'igshid',
  'mc_cid', 'mc_eid', 'ref', 'referrer', 'source', 'campaign', '_ga', '_gl', 'h',
]);

// True when `pageUrl`'s query string carries at least one parameter outside
// the known-tracking allowlist above — i.e. a parameter this platform has
// no way to prove is harmless to strip/redirect away. No query string at
// all, or a query string made ONLY of known-tracking params, returns false.
export function isLikelyFunctionalQueryParam(pageUrl) {
  let search;
  try { search = new URL(pageUrl).search; } catch { return false; }
  if (!search) return false;
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    if (!KNOWN_TRACKING_PARAMS.has(key.toLowerCase())) return true;
  }
  return false;
}

// Plain Jaccard token overlap — deterministic, no LLM, reuses whatever body
// text a caller already fetched for another reason (analyzePageUrl's
// analysis.bodyText). Not meant to be precise prose-similarity, only a
// cheap "do these two pages carry roughly the same real content" signal on
// top of URL-shape/traffic evidence.
export function textSimilarity(textA, textB) {
  const tokenize = (t) => new Set(String(t || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  const a = tokenize(textA);
  const b = tokenize(textB);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const tok of a) if (b.has(tok)) shared++;
  return shared / new Set([...a, ...b]).size;
}

// Given a same-shaped { page: value } object OR a Map, read one page's
// value without callers having to care which shape they were handed.
function lookup(byPage, page) {
  if (!byPage) return undefined;
  return byPage instanceof Map ? byPage.get(page) : byPage[page];
}

// Split-traffic escalation (see the block comment above): given the
// traffic-bearing candidates that query overlap alone couldn't resolve,
// try the additional signals in order of how strong/unambiguous they are.
// Returns null when none apply — decideWinner then falls back to its prior
// MEDIUM behavior exactly as before this signal set existed.
function resolveWithAdditionalSignals(withTraffic, {
  canonicalByPage, pagePurposeByPage, internalLinkCountByPage, functionalParamPages, contentSimilarity,
} = {}) {
  const pages = withTraffic.map((t) => t.page);

  // 1) Canonical agreement — the strongest possible signal, since it's the
  // site's own stated intent, not an inference. Winner = the one page every
  // OTHER candidate's canonical tag points at (a page's own canonical
  // pointing at itself, or being absent, doesn't disqualify it as target).
  if (canonicalByPage) {
    for (const candidate of pages) {
      const others = pages.filter((p) => p !== candidate);
      if (others.length && others.every((p) => {
        const target = lookup(canonicalByPage, p);
        return target && target.replace(/\/$/, '') === candidate.replace(/\/$/, '');
      })) {
        return {
          winner: withTraffic.find((t) => t.page === candidate),
          decision: 'consolidate',
          decisionReason: 'canonical-tag-agreement',
        };
      }
    }
  }

  // 2) A functional (non-tracking) query parameter on any traffic-bearing
  // candidate blocks consolidation outright — never redirect/canonicalize
  // away real behavioral state. Decided, not punted: these pages stay
  // independent on purpose.
  if (functionalParamPages && pages.some((p) => (functionalParamPages instanceof Set ? functionalParamPages.has(p) : functionalParamPages[p]))) {
    return { winner: null, decision: 'leave-both-independent-intent', decisionReason: 'functional-query-parameter' };
  }

  // 3) Genuinely different declared/inferred page purposes among the
  // traffic-bearing candidates — a signal they serve different intents,
  // which is a reason to leave them independent, never a reason to merge.
  if (pagePurposeByPage) {
    const purposes = pages.map((p) => lookup(pagePurposeByPage, p)).filter(Boolean);
    if (purposes.length === pages.length && new Set(purposes).size > 1) {
      return { winner: null, decision: 'leave-both-independent-intent', decisionReason: 'different-page-purpose' };
    }
  }

  // 4) High content similarity (the pages really are the same content) can
  // stand in for query-overlap confirmation when a real, non-tied click
  // margin exists — internal link count only breaks an otherwise-tied
  // margin, never overrides a real click difference.
  if (typeof contentSimilarity === 'number' && contentSimilarity >= 0.7) {
    let byMargin = [...withTraffic].sort((a, b) => b.clicks - a.clicks);
    let [top, runnerUp] = byMargin;
    if (top.clicks === runnerUp.clicks && internalLinkCountByPage) {
      byMargin = [...withTraffic].sort((a, b) => (lookup(internalLinkCountByPage, b.page) || 0) - (lookup(internalLinkCountByPage, a.page) || 0));
      [top, runnerUp] = byMargin;
      const topLinks = lookup(internalLinkCountByPage, top.page) || 0;
      const runnerUpLinks = lookup(internalLinkCountByPage, runnerUp.page) || 0;
      if (topLinks > runnerUpLinks) {
        return { winner: top, decision: 'consolidate', decisionReason: 'content-similarity-plus-internal-links' };
      }
      return null; // still tied on every available signal — genuinely inconclusive
    }
    if (top.clicks > runnerUp.clicks) {
      return { winner: top, decision: 'consolidate', decisionReason: 'content-similarity-plus-click-margin' };
    }
  }

  return null;
}

// The full decision: given a candidate set's traffic rows, decide
// 'high' | 'medium' | 'low' and — only for 'high' — which page is the
// winner. `queryOverlapChecker` is injected (rather than this function
// calling fetchQuerySets itself) so the zero/one-traffic-candidate cases
// (the overwhelming majority) never pay for a query-level fetch at all;
// callers only invoke it when withTraffic.length > 1.
//
// `signals` (all optional — see the block comment above for the exact
// shape/semantics of each) is only consulted when query overlap alone
// leaves the group at MEDIUM, and only ever narrows a MEDIUM result to a
// more specific, evidenced decision — it never overrides a HIGH result
// query overlap already reached, and never picks a winner from a tied
// click margin on its own.
export async function decideWinner(traffic, { siteId, start, end, signals } = {}) {
  const withTraffic = traffic.filter((t) => t.clicks > 0 || t.impressions > 0);

  if (withTraffic.length === 1) {
    return { confidence: 'high', winner: withTraffic[0], withTraffic, queryOverlap: null, decision: 'consolidate', decisionReason: 'sole-traffic-candidate' };
  }

  if (withTraffic.length > 1 && siteId) {
    const pages = withTraffic.map((t) => t.page);
    const querySetsByPage = await fetchQuerySets(siteId, pages, start, end);
    const overlaps = allPairsOverlapSubstantially(querySetsByPage, pages);
    if (overlaps) {
      const byClicksDesc = [...withTraffic].sort((a, b) => b.clicks - a.clicks);
      const [top, runnerUp] = byClicksDesc;
      // A real, non-tied margin only — query overlap confirms they compete
      // for the same intent, but still never picks a winner from an exact
      // tie, which would be exactly the "bigger share" guess this whole
      // model refuses to make.
      if (top.clicks > runnerUp.clicks) {
        return {
          confidence: 'high', winner: top, withTraffic,
          queryOverlap: { overlapping: true, sharedAcrossAllPairs: true, queryCountByPage: Object.fromEntries(pages.map((p) => [p, querySetsByPage.get(p)?.size || 0])) },
          decision: 'consolidate', decisionReason: 'query-overlap-plus-click-margin',
        };
      }
    }

    const queryOverlap = { overlapping: overlaps, queryCountByPage: Object.fromEntries(pages.map((p) => [p, querySetsByPage.get(p)?.size || 0])) };

    // Query overlap alone couldn't resolve it — this used to be the end of
    // the line (straight to MEDIUM/reportOnly). Now the additional signals
    // above get a chance to turn "ambiguous" into an actual autonomous
    // decision before this falls back to a human.
    const resolved = resolveWithAdditionalSignals(withTraffic, signals);
    if (resolved) {
      return {
        confidence: resolved.winner ? 'high' : 'medium', winner: resolved.winner, withTraffic,
        queryOverlap, decision: resolved.decision, decisionReason: resolved.decisionReason,
      };
    }

    return { confidence: 'medium', winner: null, withTraffic, queryOverlap, decision: null, decisionReason: null };
  }

  return { confidence: withTraffic.length > 1 ? 'medium' : 'low', winner: null, withTraffic, queryOverlap: null, decision: null, decisionReason: null };
}
