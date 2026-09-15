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

// The full decision: given a candidate set's traffic rows, decide
// 'high' | 'medium' | 'low' and — only for 'high' — which page is the
// winner. `queryOverlapChecker` is injected (rather than this function
// calling fetchQuerySets itself) so the zero/one-traffic-candidate cases
// (the overwhelming majority) never pay for a query-level fetch at all;
// callers only invoke it when withTraffic.length > 1.
export async function decideWinner(traffic, { siteId, start, end } = {}) {
  const withTraffic = traffic.filter((t) => t.clicks > 0 || t.impressions > 0);

  if (withTraffic.length === 1) {
    return { confidence: 'high', winner: withTraffic[0], withTraffic, queryOverlap: null };
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
        };
      }
    }
    return {
      confidence: 'medium', winner: null, withTraffic,
      queryOverlap: { overlapping: overlaps, queryCountByPage: Object.fromEntries(pages.map((p) => [p, querySetsByPage.get(p)?.size || 0])) },
    };
  }

  return { confidence: withTraffic.length > 1 ? 'medium' : 'low', winner: null, withTraffic, queryOverlap: null };
}
