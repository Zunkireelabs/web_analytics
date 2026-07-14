// Shared helpers for building `facts.findings` (see AGENTS types.js `Finding`)
// — every agent uses these instead of reinventing priority/impact bucketing,
// so "priority" means the same thing (a real relative-rank signal) everywhere.

// Buckets an already best-first-sorted list into high/medium/low thirds by
// rank. Same relative-comparison philosophy as ctr-anomaly.js's flagLowCtr:
// never an external/invented threshold, just "how does this rank among the
// real candidates in this run."
export function priorityByRank(sortedDescList) {
  const n = sortedDescList.length;
  if (n === 0) return [];
  return sortedDescList.map((_, i) => {
    const pct = n <= 1 ? 0 : i / (n - 1);
    if (pct <= 1 / 3) return 'high';
    if (pct <= 2 / 3) return 'medium';
    return 'low';
  });
}

// estimatedTrafficGain-style real numeric projection -> label. Kept as one
// shared, documented formula rather than a per-agent copy.
export function impactFromValue(value, { high, medium }) {
  if (value == null) return null;
  if (value >= high) return 'High';
  if (value >= medium) return 'Medium';
  return 'Low';
}

// Effort from a real 1-5 difficulty proxy (opportunity's own signal) —
// preferred over the generic per-generator effortForGenerator() fallback
// whenever an agent has computed something this specific.
export function effortFromDifficulty(difficulty) {
  if (difficulty == null) return null;
  if (difficulty <= 2) return 'Low';
  if (difficulty <= 3) return 'Medium';
  return 'High';
}

// For agents with no site-size-independent absolute threshold to bucket by
// (e.g. impressions vary by orders of magnitude between a small site and a
// large one) — impact tracks the same real relative rank as `priority`,
// rather than inventing an arbitrary absolute cutoff.
const PRIORITY_TO_IMPACT_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
export const impactFromPriority = (priority) => PRIORITY_TO_IMPACT_LABEL[priority] || 'Low';

export function makeFinding({ id, evidence, whyItMatters, priority, recommendedAction = null, expectedImpact }) {
  return { id, evidence, whyItMatters, priority, recommendedAction, expectedImpact };
}
