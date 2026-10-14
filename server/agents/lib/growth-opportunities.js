import { getQueryPageMetrics } from '../../store/read.js';
import { getKeywordGaps } from '../../store/data-analyst.js';
import { ctrAtPosition, TARGET_POSITION, opportunityScore, estimatedTrafficGain, TRAFFIC_GAIN_NOTE } from './opportunity-scoring.js';

// Website-wide Growth Opportunities (Analyst page Phase 4) — the canonical
// answer to "where can this site grow next?", built ENTIRELY from data this
// schema already has: gsc_query_page (real query+page+clicks+impressions+
// CTR+position, joined) for everything ranking, and keyword_gaps (real LLM/
// user-sourced topics with zero current coverage) for what isn't ranking at
// all. Deliberately NOT built from keyword_clusters — that table is an
// append-only 14-day-cadence snapshot (one run for Zunkiree as of this
// writing) with no page/clicks/CTR columns at all, which is exactly why
// "Close to Page 1" used to be unable to show a target page or say whether a
// keyword was worth acting on.
//
// Every opportunity type below is scored from real numbers only. There is no
// search-volume, competitor, or backlink data anywhere in this schema, so
// none of that is estimated or guessed — see TRAFFIC_GAIN_NOTE for the one
// place a genuine estimate (traffic gain from an assumed CTR curve) is used,
// always labeled as such.

const MIN_IMPRESSIONS = 10;
const RECENT_WINDOW_DAYS = 30;
// Non-overlapping with the recent window, same length, for wow-style
// decline detection — "was this query/page doing better a month before the
// last month" rather than a noisy day-over-day comparison.
const PRIOR_WINDOW_DAYS = 30;

const QUICK_WIN_MAX_POSITION = 10;
const PAGE1_MIN_POSITION = 10;
const PAGE1_MAX_POSITION = 20;
// A query underperforming its position's expected CTR by more than this
// fraction is a Quick Win — the page ranks, real searchers see it, and it's
// still being skipped more than the position alone would predict.
const QUICK_WIN_CTR_RATIO = 0.6;
// A page needs at least this many distinct real queries landing on it,
// each with real impressions, before "this page could cover more of this
// topic" is a claim backed by evidence rather than a guess from one query.
const EXPANSION_MIN_QUERIES = 3;
const DECLINE_MIN_PRIOR_CLICKS = 5;
const DECLINE_CLICK_DROP_PCT = 30;

const MAX_PER_TYPE = 12;

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(from, days) {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return isoDate(d);
}

// Collapses (query, page) rows to one row per query — the page with the most
// impressions for that query in the window — since a query can technically
// land on more than one real page across different days in the range.
function bestPagePerQuery(rows) {
  const byQuery = new Map();
  for (const r of rows) {
    const existing = byQuery.get(r.query);
    if (!existing || r.impressions > existing.impressions) byQuery.set(r.query, r);
  }
  return [...byQuery.values()];
}

function baseOpportunity(type, { query = null, cluster = null, page, avgPosition = null, impressions, clicks, ctr = null }) {
  return {
    type, query, cluster, page, intent: null, impressions, clicks, ctr, avgPosition,
    trend: null, forecast: null, severity: null, opportunityScore: null,
    reason: null, recommendedAction: null,
  };
}

function quickWins(recent) {
  return recent
    .filter((r) => r.avgPosition != null && r.avgPosition <= QUICK_WIN_MAX_POSITION && r.impressions >= MIN_IMPRESSIONS)
    .map((r) => {
      const expectedCtr = ctrAtPosition(r.avgPosition);
      const underperforming = r.ctr < expectedCtr * QUICK_WIN_CTR_RATIO;
      if (!underperforming) return null;
      const gain = estimatedTrafficGain(r.impressions, r.ctr, expectedCtr);
      return {
        ...baseOpportunity('quick-win', r),
        opportunityScore: gain,
        severity: gain >= 20 ? 'high' : gain >= 5 ? 'medium' : 'low',
        reason: `Ranks #${r.avgPosition.toFixed(1)} with ${r.impressions} impressions, but its ${(r.ctr * 100).toFixed(1)}% click-through rate is well below the ~${(expectedCtr * 100).toFixed(1)}% typical for that position.`,
        recommendedAction: 'Improve the title and meta description to close the CTR gap.',
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, MAX_PER_TYPE);
}

function page1Opportunities(recent) {
  return recent
    .filter((r) => r.avgPosition != null && r.avgPosition > PAGE1_MIN_POSITION && r.avgPosition <= PAGE1_MAX_POSITION && r.impressions >= MIN_IMPRESSIONS)
    .map((r) => {
      const score = opportunityScore(r.impressions, r.avgPosition, PAGE1_MIN_POSITION, PAGE1_MAX_POSITION);
      return {
        ...baseOpportunity('page1-opportunity', r),
        opportunityScore: score,
        severity: r.impressions >= 100 ? 'high' : r.impressions >= 30 ? 'medium' : 'low',
        reason: `Already receiving ${r.impressions} impressions at position #${r.avgPosition.toFixed(1)} — just outside page 1.`,
        recommendedAction: r.page ? 'Strengthen the existing page — deeper content, internal links, topical coverage.' : 'No landing page recorded for this query yet.',
      };
    })
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, MAX_PER_TYPE);
}

function decliningOpportunities(recent, prior) {
  const priorByKey = new Map(prior.map((r) => [`${r.query}::${r.page}`, r]));
  const out = [];
  for (const r of recent) {
    const before = priorByKey.get(`${r.query}::${r.page}`);
    if (!before || before.clicks < DECLINE_MIN_PRIOR_CLICKS) continue;
    const dropPct = ((before.clicks - r.clicks) / before.clicks) * 100;
    if (dropPct < DECLINE_CLICK_DROP_PCT) continue;
    out.push({
      ...baseOpportunity('declining', r),
      trend: { priorClicks: before.clicks, recentClicks: r.clicks, priorPosition: before.avgPosition, recentPosition: r.avgPosition, dropPct: Math.round(dropPct) },
      opportunityScore: before.clicks - r.clicks,
      severity: dropPct >= 60 ? 'high' : dropPct >= 40 ? 'medium' : 'low',
      reason: `Clicks fell from ${before.clicks} to ${r.clicks} (${Math.round(dropPct)}%) over the prior ${PRIOR_WINDOW_DAYS} days` +
        (before.avgPosition != null && r.avgPosition != null ? `, position moved from #${before.avgPosition.toFixed(1)} to #${r.avgPosition.toFixed(1)}.` : '.'),
      recommendedAction: 'Diagnose what changed on this page or in ranking, and recover the lost visibility.',
    });
  }
  return out.sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, MAX_PER_TYPE);
}

// Real co-ranking queries grouped by their shared landing page — not an ML
// cluster, just "these real queries already land on the same real page in
// gsc_query_page." A page earning meaningful impressions across several
// related queries is real evidence it could capture more of that topic.
function contentExpansionOpportunities(recent) {
  const byPage = new Map();
  for (const r of recent) {
    if (!r.page || r.impressions < MIN_IMPRESSIONS) continue;
    if (!byPage.has(r.page)) byPage.set(r.page, []);
    byPage.get(r.page).push(r);
  }
  const out = [];
  for (const [page, queries] of byPage) {
    if (queries.length < EXPANSION_MIN_QUERIES) continue;
    const impressions = queries.reduce((s, q) => s + q.impressions, 0);
    const clicks = queries.reduce((s, q) => s + q.clicks, 0);
    const avgPosition = queries.reduce((s, q) => s + q.avgPosition * q.impressions, 0) / impressions;
    out.push({
      ...baseOpportunity('content-expansion', {
        cluster: queries.map((q) => q.query), page, avgPosition, impressions, clicks, ctr: impressions ? clicks / impressions : 0,
      }),
      opportunityScore: impressions,
      severity: impressions >= 300 ? 'high' : impressions >= 100 ? 'medium' : 'low',
      reason: `Already ranks for ${queries.length} related real queries (${queries.slice(0, 3).map((q) => `"${q.query}"`).join(', ')}${queries.length > 3 ? ', …' : ''}), ${impressions} impressions combined.`,
      recommendedAction: 'Expand this page to cover the topic more completely and capture the remaining demand.',
    });
  }
  return out.sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, MAX_PER_TYPE);
}

const GAP_PRIORITY_SEVERITY = { high: 'high', medium: 'medium', low: 'low' };

// Content Gap — real topics with genuinely zero current coverage (the
// keyword_gaps review queue, server/agents/lib/analyst-seo-mapping.js writes
// these from real site-profile + clustering evidence). GSC cannot supply
// this type at all: a query with zero impressions never appears in
// gsc_query_page in the first place, so a true gap can only come from this
// table, not from aggregating search performance.
function contentGapOpportunities(gaps) {
  return gaps
    .filter((g) => g.status === 'pending_review')
    .map((g) => ({
      ...baseOpportunity('content-gap', { query: g.topic, page: g.existing_page_match || null, impressions: 0, clicks: 0 }),
      severity: GAP_PRIORITY_SEVERITY[g.priority] || 'low',
      reason: g.reason,
      recommendedAction: g.existing_page_match ? 'Expand the matched existing page to cover this topic.' : 'Create new content for this topic — no strong existing page covers it.',
      gapId: g.id,
      source: g.source,
    }))
    .slice(0, MAX_PER_TYPE);
}

export async function buildGrowthOpportunities(siteId, { end } = {}) {
  const endDate = end || isoDate(new Date());
  const recentStart = daysAgo(endDate, RECENT_WINDOW_DAYS);
  const priorEnd = daysAgo(endDate, RECENT_WINDOW_DAYS + 1);
  const priorStart = daysAgo(endDate, RECENT_WINDOW_DAYS + PRIOR_WINDOW_DAYS);

  const [recentRaw, priorRaw, gaps] = await Promise.all([
    getQueryPageMetrics(siteId, recentStart, endDate, { minImpressions: MIN_IMPRESSIONS }),
    getQueryPageMetrics(siteId, priorStart, priorEnd, { minImpressions: 1 }),
    getKeywordGaps(siteId, 'pending_review').catch(() => []),
  ]);
  const recent = bestPagePerQuery(recentRaw);
  const prior = bestPagePerQuery(priorRaw);

  const byType = {
    'quick-win': quickWins(recent),
    'page1-opportunity': page1Opportunities(recent),
    declining: decliningOpportunities(recent, prior),
    'content-expansion': contentExpansionOpportunities(recent),
    'content-gap': contentGapOpportunities(gaps),
    // AI visibility opportunities are deliberately not produced: AI
    // Recommendation Rate is currently site-level only (see migration 0035 —
    // no per-query/per-page attribution exists), so there is no real
    // evidence to point an AI-visibility opportunity at a specific keyword
    // or page. Building one anyway would be exactly the fabrication this
    // model exists to avoid.
    'ai-visibility': [],
  };

  const all = Object.values(byType).flat();

  return {
    rangeStart: recentStart,
    rangeEnd: endDate,
    counts: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])),
    total: all.length,
    opportunities: all,
    // The multi-tenant growth spec's explicit priority order — one queue a
    // caller (the daily loop, or a human on the Analyst page) can act down
    // top-to-bottom without having to know that opportunityScore is on a
    // different scale per type (see rankOpportunitiesUnified's own comment).
    rankedQueue: rankOpportunitiesUnified(all),
    assumptions: { trafficGainNote: TRAFFIC_GAIN_NOTE, targetPosition: TARGET_POSITION },
    notes: {
      'ai-visibility': 'Not produced — AI Recommendation Rate has no per-query/per-page data to attribute an opportunity to.',
    },
  };
}

// Every opportunity type above already computes a REAL severity
// (high/medium/low) from its own real evidence — impressions, click drop
// %, or the keyword-gap's own classified priority. That tier is genuinely
// comparable across types (it's always "how strong is the real evidence",
// never a type-specific unit), so it is the PRIMARY sort key here.
// opportunityScore is deliberately NOT the primary key: it's impressions
// for content-expansion, a CTR-gap traffic estimate for quick-win, and a
// raw click-count drop for declining — comparing those directly would be
// exactly the fabricated-equivalence the rest of this file refuses to do
// (see this file's own top-of-file comment on never estimating what isn't
// real). Within the same severity tier, TYPE_RANK breaks the tie using the
// spec's own stated preference order: striking-distance and CTR fixes on
// pages that already rank beat a stale page needing a refresh, which beats
// entirely new content, which beats a lower-confidence idea. Only once both
// severity AND type agree does each type's own opportunityScore decide the
// final order — a legitimate tiebreak within one type's own real unit.
const TYPE_RANK = {
  'quick-win': 0, // already ranks, cheapest real fix (title/meta) for the most immediate real gain
  'page1-opportunity': 1, // striking distance — spec tier 2, exactly
  'content-expansion': 2, // existing page, more demand to capture — spec tier 3
  declining: 2, // existing page needs a refresh — same tier as content-expansion, both "improve what's already there"
  'content-gap': 3, // net-new content for a real topic — spec tiers 4/5
  'ai-visibility': 4, // lower-confidence / not yet evidenced — spec tier 6
};
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

export function rankOpportunitiesUnified(opportunities) {
  return [...opportunities].sort((a, b) => {
    const severityDiff = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    if (severityDiff) return severityDiff;
    const typeDiff = (TYPE_RANK[a.type] ?? 5) - (TYPE_RANK[b.type] ?? 5);
    if (typeDiff) return typeDiff;
    return (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0);
  });
}
