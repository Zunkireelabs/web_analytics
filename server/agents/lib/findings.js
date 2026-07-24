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

// For a check whose failure is usually one shared, sitewide root cause (a
// template attribute, a server/CDN header, a CMS field) rather than a
// genuinely per-page fact — one finding for the whole check, not one
// near-identical finding per failing page. No arbitrary percentage
// threshold: any non-empty `affected` set becomes exactly one finding,
// same convention as mobile-usability.js's original inline version of this
// pattern (missing-viewport/misconfigured-viewport/zoom-blocked) and
// accessibility.js's missing-html-lang, which this generalizes.
//
// `checkedCount === affected.length` (every checked page failed) is always
// 'high' priority, never scaled down to 'medium'/'low' the way a single
// low-traffic page's per-page finding could be — a confirmed sitewide gap
// is never a low-priority signal regardless of any one page's traffic.
export function aggregateSystemicFinding({
  id, affected, checkedCount, getPage, getImpressions = () => 0,
  whyItMatters, extraEvidence, recommendedAction, pickRepresentative, samplesCap = 5,
}) {
  if (!affected.length) return null;
  const affectedCount = affected.length;
  const byImpressionsDesc = [...affected].sort((a, b) => (getImpressions(b) || 0) - (getImpressions(a) || 0));
  const samplePages = byImpressionsDesc.slice(0, samplesCap).map(getPage);
  const sumImpressions = affected.reduce((sum, item) => sum + (getImpressions(item) || 0), 0);
  const priority = affectedCount === checkedCount ? 'high' : 'medium';
  // Highest-impression page carries the one draftable action a systemic
  // finding can still offer — a single-page draft can't fix a sitewide
  // template issue by itself, but it's a real, immediately-actionable
  // example rather than no action at all.
  const representative = recommendedAction
    ? (pickRepresentative ? pickRepresentative(affected) : byImpressionsDesc[0])
    : null;
  const finding = makeFinding({
    id,
    evidence: { affectedCount, checkedCount, samplePages, ...(extraEvidence ? extraEvidence(affected) : {}) },
    whyItMatters: whyItMatters(affectedCount, checkedCount),
    priority,
    recommendedAction: representative ? recommendedAction(representative) : null,
    expectedImpact: { label: impactFromPriority(priority), basis: 'computed', value: sumImpressions },
  });
  // Internal-only, stripped before persistence (server/agents/lib/bulk-audit.js's
  // mergeChunkFindings) — a full-site audit calls this same check once per
  // ~20-page chunk, so the same id comes back many times, each with only
  // that chunk's own affectedCount/checkedCount. Re-invoking the same
  // whyItMatters callback with placeholder tokens gets a reusable template
  // for free (no per-call-site boilerplate) so the merge step can render
  // accurate sitewide prose from the summed totals instead of keeping
  // whichever chunk happened to run first.
  finding._whyItMattersTemplate = whyItMatters('{n}', '{c}');
  finding._repImpressions = representative ? (getImpressions(representative) || 0) : null;
  return finding;
}
