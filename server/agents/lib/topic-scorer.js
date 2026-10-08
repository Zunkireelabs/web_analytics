import { normalizeScopeKey } from './work-claims.js';

// One ranked queue of what to write next, for every source of topics.
//
// The problem: two pipelines answer "what should we write about", and they
// never meet.
//
//   * Keyword gaps are ranked by real search volume and ship through
//     qualifyAndShipContentGaps' own top-5-by-volume pool.
//   * Trend topics come from industry RSS feeds and always report demand as
//     "unverified", because no search-demand provider was ever registered.
//
// A topic that is BOTH trending right now AND genuinely searched is the best
// topic available, and today it gets no advantage at all over one that is
// merely one of the two — because nothing ever sees both facts together.
// This module is that place.
//
// Three rules it is built on:
//
//  1. REAL VOLUME BEATS A GUESS, explicitly and by a wide margin. The demand
//     tiers below are not a smooth curve; they are a statement that measured
//     demand is worth several times a model's opinion of demand. An
//     unverified topic is not banned — a genuinely hot trend with no volume
//     history yet is exactly the thing worth writing early — it just cannot
//     outrank a measured one on demand alone.
//  2. ONE COVERAGE AUTHORITY. Every coverage question goes through
//     classifyGapCoverage (migration 179's verdicts). trend-radar's own
//     alreadyCovered() slug matching is a second, disagreeing authority:
//     it can neither see a page that covers a topic under different words,
//     nor tell "covered" from "covered, but not in this language".
//  3. THE SCORE IS EXPLAINED, always. Every component is returned and
//     stored (migration 185). A score nobody can explain cannot be tuned,
//     and cannot be argued with when it is obviously wrong.

// Demand evidence, strongest first. The gap between 'measured' and the rest
// is the whole point: see rule 1.
export const DEMAND_TIERS = Object.freeze({
  // Provider returned a real monthly search volume.
  measured: 1,
  // Provider is live and says the topic is rising, but has no volume for it.
  'trend-verified': 0.6,
  // Real, dated, linkable headlines from the tenant's own industry feeds —
  // evidence that something is happening, not evidence that anyone searches
  // for it.
  'trend-only': 0.35,
  // A model's opinion. Heavily discounted on purpose; present at all only so
  // that a topic with nothing else behind it still has a defined rank rather
  // than an undefined one.
  'llm-guess': 0.15,
  none: 0.1,
});

// How much room there is to say something new. Drops are returned as drops
// rather than as a zero score, so the reason survives into the queue row.
export const COVERAGE_HEADROOM = Object.freeze({
  opportunity: 1,
  // Covered, but not for this country / language / intent. Real headroom —
  // the work is a different page, not a rewrite — so a discount rather than
  // a drop.
  market_gap: 0.7,
  language_gap: 0.7,
  intent_gap: 0.6,
  // "Not enough evidence." Not a drop: a topic nobody can confirm is covered
  // may well be an opportunity. Discounted hard so a confirmed opportunity
  // always wins when both exist.
  uncertain: 0.4,
});

export const COVERAGE_DROPS = Object.freeze({
  covered: 'already-covered',
  duplicate: 'duplicate-of-existing-page',
});

// Goal alignment, as produced by pickBestGoalAlignment. A topic that serves
// no active goal is NOT penalised below 1 — penalising it would mean a
// tenant with no goals recorded scores every topic at zero. Alignment only
// ever adds.
export const GOAL_MULTIPLIER = Object.freeze({
  strong: 1.4, partial: 1.15, weak: 1.05, none: 1, insufficient_evidence: 1,
});

// Product relevance, as produced by classifyGapRelevance. Same principle:
// 'unknown' is 1, not 0 — absence of evidence is not evidence of
// irrelevance, which was the exact bug that stopped every product tenant
// from shipping any keyword gap.
export const RELEVANCE_MULTIPLIER = Object.freeze({
  core: 1.5, adjacent: 1.15, peripheral: 0.7, unrelated: 0.3, unknown: 1,
});

// Weak evidence for relevance should not get the full multiplier — see
// describeTenantForRelevance's confidence ladder. A 'core' verdict derived
// from an industry string is not the same claim as one derived from
// verified capability rows.
export const RELEVANCE_CONFIDENCE_DAMPING = Object.freeze({ high: 1, medium: 0.7, low: 0.4, unknown: 0.4 });

export const DEFAULT_QUEUE_LIMIT = 20;

export function topicKeyFor(topic) {
  return normalizeScopeKey('topic', topic);
}

// Volume is normalised logarithmically, not linearly. A 50,000/month term is
// not fifty times better than a 1,000/month one — it is broader, usually
// harder, and often less specific to the tenant. Log keeps a high-volume
// term ahead without letting it erase every other component.
export function normalizeVolume(searchVolume) {
  const v = Number(searchVolume);
  if (!Number.isFinite(v) || v <= 0) return 0;
  // ln(1 + v) / ln(1 + 50000) — 50k saturates at 1.0, which is comfortably
  // above anything a tenant-specific long-tail topic reaches.
  return Math.min(1, Math.log1p(v) / Math.log1p(50000));
}

// Which demand tier a candidate's evidence actually supports. Deliberately
// derived from the evidence rather than declared by the caller, so no
// pipeline can promote its own topics by labelling them.
export function demandTierFor({ demand = null, trendStrength = 0, llmEstimatedVolume = null } = {}) {
  if (demand?.available && Number(demand.searchVolume) > 0) return 'measured';
  if (demand?.available && demand.volumeTrend === 'rising') return 'trend-verified';
  if (trendStrength > 0) return 'trend-only';
  if (Number(llmEstimatedVolume) > 0) return 'llm-guess';
  return 'none';
}

// Real, dated headlines from more than one outlet are better evidence that
// something is happening than several headlines from one. Mirrors
// validateTopics' own "more distinct outlets, then freshest" ordering.
export function trendStrengthScore({ distinctSources = 0, newestAgeDays = null } = {}) {
  if (!distinctSources) return 0;
  const breadth = Math.min(1, distinctSources / 3);
  // Freshness decays over the same 7-day window trend-radar uses.
  const freshness = newestAgeDays == null ? 0.5 : Math.max(0, Math.min(1, 1 - (newestAgeDays / 7)));
  return Math.round((0.6 * breadth + 0.4 * freshness) * 100) / 100;
}

/**
 * Pure. Score one topic candidate.
 *
 * candidate: {
 *   topic, origin, sources?: string[], intent?,
 *   demand?: SearchDemandSignal, trend?: { distinctSources, newestAgeDays },
 *   llmEstimatedVolume?, coverageStatus?,
 *   relevance?: { productRelevance, confidence },
 *   goalAlignment?: { level },
 *   claimed?: boolean, suppressed?: boolean,
 * }
 */
export function scoreTopicCandidate(candidate = {}) {
  const topic = String(candidate.topic || '').trim();
  const components = {};

  if (!topic) return { topic, score: 0, components, dropped: 'no-topic' };

  // A caller may have already established a drop reason the scorer has no
  // way to see — most importantly that a previous cycle already shipped
  // this topic. Honoured rather than overwritten, so the real reason
  // reaches the queue row.
  if (candidate.dropped) return { topic, topicKey: topicKeyFor(topic), score: 0, components, dropped: candidate.dropped };

  // Phase 1's ledger wins before any scoring. Another producer already owns
  // this topic, or a measured regression banned this work here — either way
  // the score is irrelevant, and computing one would invite a reader to
  // argue with it.
  if (candidate.claimed) return { topic, score: 0, components, dropped: 'claimed-by-another-producer' };
  if (candidate.suppressed) return { topic, score: 0, components, dropped: 'suppressed' };

  const coverageStatus = candidate.coverageStatus || null;
  if (coverageStatus && COVERAGE_DROPS[coverageStatus]) {
    return { topic, score: 0, components, dropped: COVERAGE_DROPS[coverageStatus] };
  }

  const trendStrength = trendStrengthScore(candidate.trend || {});
  const tier = demandTierFor({
    demand: candidate.demand,
    trendStrength,
    llmEstimatedVolume: candidate.llmEstimatedVolume,
  });

  // Within the measured tier, the actual volume differentiates. Within every
  // other tier it cannot, because there is no volume to differentiate on —
  // so the tier weight alone carries it, and a trend's own strength
  // modulates the trend tiers.
  const demandBase = DEMAND_TIERS[tier];
  const demandScore = tier === 'measured'
    ? demandBase * (0.4 + 0.6 * normalizeVolume(candidate.demand.searchVolume))
    : (tier === 'trend-only' || tier === 'trend-verified')
      ? demandBase * (0.5 + 0.5 * trendStrength)
      : demandBase;

  const relevanceLevel = candidate.relevance?.productRelevance || 'unknown';
  const rawRelevance = RELEVANCE_MULTIPLIER[relevanceLevel] ?? 1;
  const damping = RELEVANCE_CONFIDENCE_DAMPING[candidate.relevance?.confidence || 'unknown'] ?? 0.4;
  // Damping pulls the multiplier TOWARD 1 (neutral), not toward 0. Weak
  // evidence should weaken a claim, not invert it: a low-confidence 'core'
  // must not end up scoring below an unknown.
  const relevanceMultiplier = 1 + ((rawRelevance - 1) * damping);

  const goalLevel = candidate.goalAlignment?.level || 'none';
  const goalMultiplier = GOAL_MULTIPLIER[goalLevel] ?? 1;

  const headroom = coverageStatus ? (COVERAGE_HEADROOM[coverageStatus] ?? 0.5) : 0.5;

  // One extra multiplier that exists only because of the gap this module was
  // written to close: a topic BOTH a trend feed and a keyword pipeline put
  // forward has two independent kinds of evidence behind it, which is
  // strictly more than either alone.
  const sources = Array.isArray(candidate.sources) && candidate.sources.length
    ? [...new Set(candidate.sources)]
    : [candidate.origin].filter(Boolean);
  const corroborationMultiplier = sources.length > 1 ? 1.25 : 1;

  const score = demandScore * relevanceMultiplier * goalMultiplier * headroom * corroborationMultiplier;

  Object.assign(components, {
    demandTier: tier,
    demandScore: round(demandScore),
    searchVolume: candidate.demand?.available ? (candidate.demand.searchVolume ?? null) : null,
    volumeTrend: candidate.demand?.volumeTrend ?? null,
    trendStrength,
    relevanceLevel,
    relevanceConfidence: candidate.relevance?.confidence || 'unknown',
    relevanceMultiplier: round(relevanceMultiplier),
    goalLevel,
    goalMultiplier,
    coverageStatus,
    coverageHeadroom: headroom,
    sources,
    corroborationMultiplier,
  });

  return { topic, topicKey: topicKeyFor(topic), score: round(score), components, dropped: null };
}

const round = (n) => Math.round(n * 1000) / 1000;

// Rank a whole batch. Pure, so the ordering is testable without a database,
// and separate from persistence so a caller can inspect a ranking before
// committing to it.
//
// Dropped candidates are RETURNED, not filtered away: the reason a topic did
// not make the queue is the most useful thing to be able to read later, and
// migration 185 keeps a row for it.
export function rankTopicCandidates(candidates = [], { limit = DEFAULT_QUEUE_LIMIT } = {}) {
  const scored = candidates.map((c) => ({ ...scoreTopicCandidate(c), candidate: c }));
  const queued = scored
    .filter((s) => !s.dropped)
    .sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic));
  return {
    queued: queued.slice(0, limit),
    overflow: queued.slice(limit),
    dropped: scored.filter((s) => s.dropped),
  };
}

export function isTopicScorerEnabled(env = process.env) {
  return env.TOPIC_SCORER_ENABLED === 'true';
}
