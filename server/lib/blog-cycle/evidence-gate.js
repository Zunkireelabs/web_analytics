// THE EVIDENCE GATE: what replaces a person's approval of a blog topic. PURE: everything it needs is passed in, so every rule is tested without a
// database or a model. A topic ships only if every gate passes; the verdict, each gate's reason, the evidence used and a priority are all returned
// so they can be stored in the topic decision log and read back by a person.
//
// The rules that matter (owner, 2026-11-25):
//  - BUSINESS RELEVANCE decides, never volume. The relevance verdict comes from this client's own business profile (agents/lib/topic-relevance.js:
//    what the company sells, its customers' problems, its audience). Search volume is only ever used to ORDER topics that are already relevant: a
//    low-volume topic that fits the business passes; a high-volume topic that does not fit is rejected. 'unknown' (no verified profile, model
//    unavailable) is held, never accepted.
//  - NEVER DUPLICATE, NEVER CANNIBALISE: against the content index (published, drafts, approved, open PR, merged) and the coverage authority
//    (classifyGapCoverage), and against real Search Console data: a page that already ranks near the top for the topic's queries is competition.
//  - REAL EVIDENCE: at least one real signal (search impressions, measured demand, a competitor gap, a trend with cited sources, a data-driven
//    detector). Nothing is written because a quota exists.
//  - A topic a person asked for by name (clientRequested) is that person's decision: it skips relevance, coverage and cannibalisation, but never the
//    in-flight duplicate check (the same topic already in a draft or an open PR is not written twice).
import { topicTokens, queryContainment } from '../content-index/normalize.js';

export const GATE = Object.freeze({ RELEVANCE: 'business-relevance', DUPLICATE: 'not-duplicate', COVERED: 'not-already-covered', CANNIBAL: 'no-cannibalisation', EVIDENCE: 'has-real-evidence' });

export const THRESHOLDS = Object.freeze({
  cannibalMaxPosition: 20,      // an existing page ranking this well (or better) for the topic is competition
  cannibalMinImpressions: 10,   // ...if it really gets impressions for it
  cannibalOverlap: 0.75,        // share of the topic's words found in the ranking query
});

// Detectors whose findings are derived from this site's own data (not guesses): their presence counts as evidence, weaker than a measurement.
export const DATA_DETECTORS = new Set(['content-gap', 'ai-recommendation', 'keyword-narrative', 'analyst-keyword-gaps', 'trend-radar', 'growth-opportunities', 'topic-research']);

const log10p = (n) => Math.log10(1 + Math.max(0, Number(n) || 0));
const round = (n) => Math.round(n * 10) / 10;

/** Pure. The real evidence found for a topic, by kind. */
export function collectEvidence({ gsc = {}, demand = null, signals = {}, clientRequested = false } = {}) {
  const evidence = [];
  const related = Array.isArray(gsc.relatedQueries) ? gsc.relatedQueries : [];
  const impressions = related.reduce((n, r) => n + (Number(r.impressions) || 0), 0);
  if (impressions > 0) evidence.push({ kind: 'search-impressions', impressions, queries: related.slice(0, 3).map((r) => r.query) });
  if (demand && demand.searchVolume != null && Number(demand.searchVolume) > 0) evidence.push({ kind: 'search-demand', searchVolume: Number(demand.searchVolume) });
  if (signals.competitor) evidence.push({ kind: 'competitor-gap' });
  if (signals.trend) evidence.push({ kind: 'trend' });
  const det = (signals.detectors || []).filter((d) => DATA_DETECTORS.has(d));
  if (det.length) evidence.push({ kind: 'detector', detectors: det });
  if (clientRequested) evidence.push({ kind: 'person-requested' });
  return evidence;
}

/** Pure. Existing pages that already rank for this topic and so would compete with a new article. */
export function findCannibalisation({ topic, rankingPages = [], targetUrl = null, thresholds = THRESHOLDS }) {
  const tokens = topicTokens(topic);
  if (!tokens.length) return [];
  const hits = new Map();
  for (const r of rankingPages) {
    if (!r?.page || (targetUrl && r.page === targetUrl)) continue;
    if (queryContainment(tokens, r.query) < thresholds.cannibalOverlap) continue;
    if (r.position == null || r.position > thresholds.cannibalMaxPosition) continue;
    if ((Number(r.impressions) || 0) < thresholds.cannibalMinImpressions) continue;
    const prev = hits.get(r.page);
    if (!prev || r.impressions > prev.impressions) hits.set(r.page, { page: r.page, query: r.query, position: r.position, impressions: Number(r.impressions) || 0 });
  }
  return [...hits.values()].sort((a, b) => a.position - b.position);
}

/** Pure. 0..60 from how well the topic fits THIS business. Volume never enters here. */
export function relevanceScore(relevance) {
  if (!relevance || relevance.verdict !== 'accept') return 0;
  const anchors = Array.isArray(relevance.anchors) ? relevance.anchors.length : 0;
  const c = relevance.criteria || {};
  return Math.min(60, 20 + Math.min(20, anchors * 10) + (c.addressesCustomerProblem ? 10 : 0) + (c.matchesAudience ? 10 : 0));
}

/** Pure. Priority among topics that already passed. Relevance dominates (up to 60); demand and search data only order the relevant. */
export function topicPriority({ relevance, evidence = [] }) {
  const impressions = evidence.find((e) => e.kind === 'search-impressions')?.impressions || 0;
  const volume = evidence.find((e) => e.kind === 'search-demand')?.searchVolume || 0;
  const bonus = Math.min(10, (evidence.some((e) => e.kind === 'competitor-gap') ? 5 : 0) + (evidence.some((e) => e.kind === 'trend') ? 5 : 0));
  return round(relevanceScore(relevance) + Math.min(20, 5 * log10p(impressions)) + Math.min(10, 3 * log10p(volume)) + bonus);
}

/**
 * @param {object} p
 *   topic, clientRequested
 *   relevance   { verdict: 'accept'|'reject'|'unknown', reasons, anchors, criteria, source }
 *   index       result of checkTopicAgainstIndex ({ ok, matches, reason })
 *   coverage    { status, url } from classifyGapCoverage, or null when unavailable
 *   gsc         { relatedQueries: [{ query, impressions, clicks, position }], rankingPages: [{ page, query, impressions, position }], unavailable?: 'reason' }
 *   demand      { searchVolume } or null
 *   signals     { competitor, trend, detectors: [] }
 * @returns {{ decision: 'accepted'|'rejected'|'deferred', gates: Array, evidence: Array, priority: number|null, relevance: object, reasons: string[] }}
 */
export function evaluateTopic({ topic, clientRequested = false, relevance = null, index = { ok: true, matches: [] }, coverage = null, gsc = {}, demand = null, signals = {}, targetUrl = null, thresholds = THRESHOLDS } = {}) {
  const gates = [];
  const verdict = relevance?.verdict || 'unknown';

  // 1. business relevance (a person's own request is their decision)
  if (clientRequested) gates.push({ gate: GATE.RELEVANCE, ok: true, detail: 'requested by a person; relevance is their call' });
  else if (verdict === 'accept') gates.push({ gate: GATE.RELEVANCE, ok: true, detail: (relevance.reasons || []).join('; ') || 'relevant to what this business sells and its customers' });
  else if (verdict === 'reject') gates.push({ gate: GATE.RELEVANCE, ok: false, detail: (relevance.reasons || []).join('; ') || 'not relevant to this business' });
  else gates.push({ gate: GATE.RELEVANCE, ok: false, held: true, detail: (relevance?.reasons || []).join('; ') || 'relevance could not be judged (no verified business profile, or the judge was unavailable)' });

  // 2. not a duplicate of anything published, drafted, approved, in a PR or merged (never skipped, even for a requested topic)
  gates.push({ gate: GATE.DUPLICATE, ok: index.ok !== false, detail: index.ok === false ? index.reason : 'no matching page, draft, pull request or merged content', matches: (index.matches || []).slice(0, 3) });

  // 3. the one coverage authority
  const covered = !clientRequested && ['covered', 'duplicate'].includes(coverage?.status) && coverage?.url;
  gates.push({ gate: GATE.COVERED, ok: !covered, detail: covered ? `an existing page already covers this topic (${coverage.status}): ${coverage.url}` : (coverage ? `coverage check: ${coverage.status}` : 'coverage check unavailable') });

  // 4. real search data: an existing page already ranking for this is competition
  const competing = clientRequested ? [] : findCannibalisation({ topic, rankingPages: gsc.rankingPages, targetUrl, thresholds });
  if (gsc.unavailable && !clientRequested) {
    // Without search data the cannibalisation question cannot be answered: held, never assumed fine.
    gates.push({ gate: GATE.CANNIBAL, ok: false, held: true, detail: `search data was unavailable (${gsc.unavailable}); competition with an existing page could not be checked` });
  } else gates.push({
    gate: GATE.CANNIBAL, ok: competing.length === 0,
    detail: competing.length ? `${competing[0].page} already ranks #${Math.round(competing[0].position)} for "${competing[0].query}" (${competing[0].impressions} impressions); a new article would compete with it` : 'no existing page ranks for this topic',
    competing: competing.slice(0, 3),
  });

  // 5. at least one real signal
  const evidence = collectEvidence({ gsc, demand, signals, clientRequested });
  gates.push({ gate: GATE.EVIDENCE, ok: evidence.length > 0, detail: evidence.length ? `${evidence.map((e) => e.kind).join(', ')}` : 'no search impressions, measured demand, competitor gap, trend or data-driven detector supports this topic' });

  const failed = gates.filter((g) => !g.ok);
  const onlyHeld = failed.length > 0 && failed.every((g) => g.held);
  const decision = failed.length === 0 ? 'accepted' : onlyHeld ? 'deferred' : 'rejected';
  return {
    decision, gates, evidence,
    priority: decision === 'accepted' ? topicPriority({ relevance: clientRequested ? { verdict: 'accept', anchors: [], criteria: {} } : relevance, evidence }) : null,
    relevance: relevance || { verdict: 'unknown', reasons: [] },
    reasons: failed.map((g) => `${g.gate}: ${g.detail}`),
  };
}
