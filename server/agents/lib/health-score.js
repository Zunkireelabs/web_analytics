// Website Health score — one composite 0-100 number derived from every
// specialist agent's real findings, never a single agent's own score.
//
// Formula: start at 100, subtract a weighted penalty per finding.
//   penalty(finding) = tierWeight(priority) * (0.5 + 0.5 * normalizedMagnitude)
// tierWeight is 3/2/1 for high/medium/low (severity). normalizedMagnitude is
// the finding's own real evidence value (estimatedTrafficGain, impressions,
// session delta, etc. — whatever `expectedImpact.value` already holds)
// scaled 0..1 relative to the WORST finding in this same run — a relative
// comparison, never an external/absolute benchmark, same philosophy as
// ctr-anomaly.js's flagLowCtr elsewhere in this codebase.
//
// Findings are deduped before penalizing: if two agents flag the same
// underlying issue on the same page (e.g. content-gap's "Missing FAQ" and
// ai-visibility's "Add an FAQ section" on the same URL), only the
// highest-severity copy counts — so total penalty reflects distinct real
// problems, not how many agents happened to notice the same one.

const TIER_WEIGHT = { high: 3, medium: 2, low: 1 };

// Caps total penalty so the score can't be dragged toward 0 by sheer finding
// volume on a large site — 0 would misleadingly read as "the site is down,"
// which a findings count alone never actually means.
const MAX_PENALTY = 65;
const FLOOR = 20;

// Groups a finding by the real-world thing it's about, so the same issue
// reported by two agents collapses to one. Page-level findings key on
// page+category (category = the generator it maps to, or its own gap/tag
// label when there's no generator). Non-page findings (country/device/query-
// level) key on the agent + the specific dimension named in its evidence —
// these don't overlap across agents, so a single fallback is enough.
function dedupeKey(f) {
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
export function computeHealthScore(findings) {
  const scoreable = (findings || []).filter((f) => TIER_WEIGHT[f.priority] != null);
  if (!scoreable.length) return { score: 100, penalty: 0, findingsConsidered: 0, findingsReported: 0 };

  const bestByKey = new Map();
  for (const f of scoreable) {
    const key = dedupeKey(f);
    const existing = bestByKey.get(key);
    if (!existing || TIER_WEIGHT[f.priority] > TIER_WEIGHT[existing.priority]) bestByKey.set(key, f);
  }
  const deduped = [...bestByKey.values()];

  const magnitudes = deduped.map((f) => Math.abs(f.expectedImpact?.value ?? 0));
  const maxMagnitude = Math.max(1, ...magnitudes);

  let penalty = 0;
  for (const f of deduped) {
    const tier = TIER_WEIGHT[f.priority];
    const normalizedMagnitude = Math.abs(f.expectedImpact?.value ?? 0) / maxMagnitude;
    penalty += tier * (0.5 + 0.5 * normalizedMagnitude);
  }
  penalty = Math.min(MAX_PENALTY, penalty);

  return {
    score: Math.max(FLOOR, Math.round(100 - penalty)),
    penalty: Math.round(penalty),
    findingsConsidered: deduped.length,
    findingsReported: scoreable.length,
  };
}
