// Website Health score — one composite 0-100 number derived from every
// specialist agent's real findings, never a single agent's own score.
//
// Formula: start at 100, subtract a weighted penalty per finding.
//   penalty(finding) = categoryWeight(agentId) * tierWeight(priority) * (0.5 + 0.5 * normalizedMagnitude)
// tierWeight is 3/2/1 for high/medium/low (severity, per-agent-relative —
// see agents/lib/findings.js's priorityByRank). categoryWeight (see
// CATEGORY_WEIGHT below) calibrates severity ACROSS agents/categories, so a
// "high" security finding and a "high" content finding aren't treated as
// equally severe just because each agent independently called itself high.
// normalizedMagnitude is the finding's own real evidence value
// (estimatedTrafficGain, impressions, session delta, etc. — whatever
// `expectedImpact.value` already holds) scaled 0..1 relative to the WORST
// finding in this same run — a relative comparison, never an external/
// absolute benchmark, same philosophy as ctr-anomaly.js's flagLowCtr
// elsewhere in this codebase.
//
// Findings are deduped before penalizing: if two agents flag the same
// underlying issue on the same page (e.g. content-gap's "Missing FAQ" and
// ai-visibility's "Add an FAQ section" on the same URL), only the
// highest-severity copy counts — so total penalty reflects distinct real
// problems, not how many agents happened to notice the same one.

const TIER_WEIGHT = { high: 3, medium: 2, low: 1 };

// Category severity calibration — a deliberate, reviewed judgment call, not
// an automatically-learned or "scientifically derived" scale. TIER_WEIGHT
// alone treats a "high" security finding and a "high" content finding as
// equally severe just because both agents independently called themselves
// high (each agent's priorityByRank only ranks within its OWN findings —
// see agents/lib/findings.js) — in reality a missing HSTS header and a
// missing FAQ section are not the same order of real-world risk. Built only
// once real findings existed across enough categories to calibrate against
// (security-headers.js, accessibility.js, internal-linking.js, etc. —
// Website Intelligence plan Phase 7-9), not guessed in advance per Phase 10.
// Revisit these numbers as real findings volume/impact data accumulates;
// they are explicitly not meant to be permanent.
const CATEGORY_WEIGHT = {
  security: 1.5, // real, direct risk (data exposure, MITM) when present — the clearest case for weighting above the reference tier
  seo: 1.0, // reference tier — crawlability/indexing/technical health, the largest and most established category
  technical: 1.0, // reserved for a future split-out of seo's crawlability/indexing concerns (see types.js); same severity class as seo
  performance: 1.15, // real UX/ranking impact (Core Web Vitals) once a dedicated agent exists (plan Phase 12)
  accessibility: 1.15, // real usability/legal-exposure stakes, though rarely as immediately consequential as an actual security hole
  content: 0.85, // quality/completeness opportunities, not "broken" states
  'on-page': 0.85, // reserved for a future split-out of content-quality checks (see types.js); same severity class as content
  geo: 0.8, // localization/geographic signals are genuinely upside-framed (see insights.js's OPPORTUNITY_AGENT_IDS), not problem-framed
};
const DEFAULT_CATEGORY_WEIGHT = 1.0;

// `categoryByAgentId` is the same Map command-center.js's categoryByAgentId()
// already builds from the live agent registry (agentId -> {category, name})
// — passed in rather than looked up here so this function stays synchronous
// and pure/testable; omitting it (or passing an unrecognized agentId)
// resolves to DEFAULT_CATEGORY_WEIGHT (1.0, a no-op multiplier), so every
// existing/future caller that doesn't opt in keeps today's exact formula.
function categoryWeightFor(agentId, categoryByAgentId) {
  const category = categoryByAgentId?.get(agentId)?.category;
  return CATEGORY_WEIGHT[category] ?? DEFAULT_CATEGORY_WEIGHT;
}

// Caps total penalty so the score can't be dragged toward 0 by sheer finding
// volume on a large site — 0 would misleadingly read as "the site is down,"
// which a findings count alone never actually means. Kept in sync with FLOOR
// (100 - MAX_PENALTY === FLOOR) so the floor below is actually reachable
// instead of dead code the penalty cap can never reach.
const MAX_PENALTY = 80;
const FLOOR = 20;

// Groups a finding by the real-world thing it's about, so the same issue
// reported by two agents collapses to one. Page-level findings key on
// page+category (category = the generator it maps to, or its own gap/tag
// label when there's no generator). Non-page findings (country/device/query-
// level) key on the agent + the specific dimension named in its evidence —
// these don't overlap across agents, so a single fallback is enough.
// Exported for growth-projection.js: simulating "this issue is resolved"
// requires marking every RAW finding that maps to the same dedupeKey as
// implemented, not just the single highest-severity representative
// getOpenScoreableFindings picked — otherwise a lower-severity duplicate for
// the same real issue (flagged by a different agent) resurfaces as the new
// dedup winner once the representative is excluded, and the projection can
// never actually reach a clean 100.
export function dedupeKey(f) {
  const page = f.evidence?.page;
  if (page) {
    const category = f.recommendedAction?.generatorId || f.evidence?.gapType || f.recommendedAction?.label || f.id;
    return `${page}::${category}`;
  }
  const dim = f.evidence?.country ?? f.evidence?.city ?? f.evidence?.device ?? f.evidence?.query ?? f.evidence?.language;
  return `${f.agentId}::${dim ?? f.id}`;
}

// `findings` = flat array across every primary agent, each already tagged
// with `agentId` (the shape orchestrator.js and getLatestFindings both
// produce). Findings with no recognized priority tier are ignored rather
// than crashing — defensive against future agents whose findings don't set
// priority for some reason.
//
// `implementedFindingIds` (a Set, same shape as buildRecommendations'
// getImplementedFindingIds — see agents/lib/recommendations.js) excludes any
// finding with an already-implemented draft BEFORE dedup, not just from the
// final list — otherwise an already-shipped finding could still win the
// page+category dedup slot over a still-open one from a different agent,
// silently continuing to penalize a page for an issue that's actually
// fixed. Optional/defaults to empty so existing callers that don't pass it
// keep today's behavior unchanged.
//
// The "what counts as an open, distinct issue" step, pulled out so
// growth-projection.js (a hypothetical "what if these got fixed" simulation)
// uses the exact same open/deduped finding set the real score is computed
// from — not a second, potentially-inconsistent notion of what's open.
export function getOpenScoreableFindings(findings, implementedFindingIds = new Set()) {
  const scoreable = (findings || [])
    .filter((f) => TIER_WEIGHT[f.priority] != null)
    .filter((f) => !implementedFindingIds.has(f.id));

  const bestByKey = new Map();
  for (const f of scoreable) {
    const key = dedupeKey(f);
    const existing = bestByKey.get(key);
    if (!existing || TIER_WEIGHT[f.priority] > TIER_WEIGHT[existing.priority]) bestByKey.set(key, f);
  }
  return [...bestByKey.values()];
}

// `categoryByAgentId` (optional, agentId -> {category, name}) applies the
// CATEGORY_WEIGHT calibration above; omitted, every finding gets the
// DEFAULT_CATEGORY_WEIGHT no-op multiplier — existing/future callers that
// don't pass it keep today's exact formula.
export function computeHealthScore(findings, implementedFindingIds = new Set(), categoryByAgentId = new Map()) {
  const deduped = getOpenScoreableFindings(findings, implementedFindingIds);
  const reportedCount = (findings || [])
    .filter((f) => TIER_WEIGHT[f.priority] != null)
    .filter((f) => !implementedFindingIds.has(f.id)).length;
  if (!deduped.length) return { score: 100, penalty: 0, findingsConsidered: 0, findingsReported: 0 };

  const magnitudes = deduped.map((f) => Math.abs(f.expectedImpact?.value ?? 0));
  const maxMagnitude = Math.max(1, ...magnitudes);

  let penalty = 0;
  for (const f of deduped) {
    const tier = TIER_WEIGHT[f.priority];
    const normalizedMagnitude = Math.abs(f.expectedImpact?.value ?? 0) / maxMagnitude;
    const weight = categoryWeightFor(f.agentId, categoryByAgentId);
    penalty += weight * tier * (0.5 + 0.5 * normalizedMagnitude);
  }
  penalty = Math.min(MAX_PENALTY, penalty);

  return {
    score: Math.max(FLOOR, Math.round(100 - penalty)),
    penalty: Math.round(penalty),
    findingsConsidered: deduped.length,
    findingsReported: reportedCount,
  };
}
