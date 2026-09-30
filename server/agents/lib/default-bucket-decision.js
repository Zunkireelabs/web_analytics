import { DEFAULT_CLASSIFICATION } from './recommendation-taxonomy.js';
import { evidenceGatherer } from './decision-evidence.js';

// decision-engine.js is imported LAZILY (inside defaultDecisionEngineFn
// below), never at module scope. decision-engine.js imports llm.js, whose
// import graph reaches the openai SDK's formdata-node dependency — the same
// module-mocking incompatibility backend.js's own doc comment already
// documents for computeBrokenLinkFixMerge (web-streams-polyfill's ESM
// interop breaks under node:test's --experimental-test-module-mocks).
// recommendations.js imports this module unconditionally, so a static,
// top-level import here would drag that broken chain into EVERY test that
// imports recommendations.js — including ones that never touch the
// Decision Engine and have no reason to mock it (confirmed: adding a static
// import broke recommendations.goal-alignment.test.js and
// recommendations.report-only.test.js, neither of which reference decision
// logic at all). A dynamic import only ever executes on the real path this
// module is scoped to (flag enabled, real candidates, no DI override) —
// every test either stubs decisionEngineFn directly or never reaches this
// branch, so the dynamic import is never hit in any test file.
async function defaultDecisionEngineFn(...args) {
  const { decisionEngine } = await import('./decision-engine.js');
  return decisionEngine.decide(...args);
}

// Scoped Decision Engine integration (2026-09-29 architecture audit) — the
// ONLY place decide() is wired into the main recommendation-building path.
// Every other classifier/gate (classify() itself, autonomy-decision.js's
// risk-tier ceiling, ship-pacing.js's convergence caps, attempt-
// classification.js's retry rules, capability-gap-detector.js's clustering
// threshold) stays exactly as deterministic as before this module existed —
// the audit's own conclusion was that none of those are "reasoning under
// uncertainty with room for a different conclusion"; they're closed-form
// classification over already-known facts. The one genuine candidate is a
// finding recommendation-taxonomy.js's classify() cannot place at all —
// DEFAULT_CLASSIFICATION, its catch-all — which is exactly what this scopes
// to and nothing wider.
//
// Feature-flagged per site (sites.decision_engine_default_bucket_enabled,
// migration 174), default OFF. With the flag off, or with no DEFAULT-bucket
// candidates this run, buildRecommendations' output is unchanged from
// before this module existed — see the early return below.

// How many DEFAULT-bucket findings actually invoke decide() in one
// buildRecommendations() call, regardless of how many hit DEFAULT that run.
// A real LLM call per finding, sitewide, every day, was explicitly the cost
// risk the architecture audit flagged (decide() was previously reachable
// only through the rare capability-gap path). Findings beyond the cap fall
// through with no decisionId set — i.e. exactly today's DEFAULT behavior,
// unchanged, never a broken or missing recommendation. Deliberately a fixed
// constant rather than a per-site setting: this is an experimental
// integration on one test tenant first, not a tunable production knob yet.
export const MAX_DECISION_ENGINE_CALLS_PER_RUN = 5;

export function isDefaultBucketClassification(classification) {
  return classification === DEFAULT_CLASSIFICATION;
}

// A real, grounded situation/evidence pair for decide() — never fabricates
// anything beyond what the finding and the taxonomy miss already say.
export function buildDefaultBucketSituation({ agentId, generatorId, whyItMatters, label }) {
  const situation = `A finding matched no known recommendation category (source "${agentId}", generatorId "${generatorId}"): ${whyItMatters || label || 'no description given by the detecting agent'}.`;
  const evidence = [
    {
      source: agentId,
      summary: whyItMatters || label || 'No description given by the detecting agent.',
      ref: `generatorId:${generatorId}`,
    },
    {
      source: 'recommendation-taxonomy',
      summary: `No BY_SOURCE_AND_GENERATOR or BY_GENERATOR entry matched source "${agentId}" / generatorId "${generatorId}" — classified via the DEFAULT catch-all.`,
      ref: generatorId,
    },
  ];
  return { situation, evidence };
}

// `candidates`: [{ item, situation, evidence }] — pre-built only for items
// buildRecommendations already pushed via its actionable (generatorId) path
// and classified as DEFAULT_CLASSIFICATION. report-only findings are never
// candidates here: a reportOnly finding is already a confirmed defect with
// no fix action to reason about (see recommendations.js's own doc comment),
// not an ambiguous one — decide()'s do_nothing/investigate_further verdicts
// would have nothing meaningful to change for them.
//
// Returns the (possibly filtered) items array. 'do_nothing' is the ONE case
// this module is allowed to change which recommendations exist — those
// items are removed from the returned array (suppressed from the output
// set). Every other outcome is additive-only: decisionId (and, for
// investigate_further, decisionState) is attached to the item object in
// place; blockedReason/riskTier/generatorId/params/goalId/goalAlignment are
// never touched here, by construction (this module doesn't import or call
// anything that could). A decide() failure or thrown error for one
// candidate leaves that item completely unchanged — the safe fallback to
// existing deterministic DEFAULT behavior — and never stops the rest of the
// run or the other candidates.
export async function applyDefaultBucketDecisions(siteId, items, candidates, {
  site, decisionEngineFn = defaultDecisionEngineFn, maxCalls = MAX_DECISION_ENGINE_CALLS_PER_RUN,
  // Reuses the SAME cross-domain evidence gatherer gap-action-resolver.js
  // already gathers, its own architecture and cost profile unchanged.
  // 'generic' is the honest situationType here (not 'traffic_decline' or
  // 'keyword_opportunity' — this module has no idea which domain a
  // DEFAULT-bucket finding belongs to; that's the whole reason it's in the
  // catch-all), which SOURCES_BY_SITUATION already maps to its widest source
  // set (recommendations, memory, investigations, siteUnderstanding,
  // pastDecisions) — real SEO/design/Analyst/history evidence already
  // co-resident in those same tables, not a new evidence system.
  gatherEvidenceFn = evidenceGatherer.gatherCorrelatedEvidence,
} = {}) {
  if (!site?.decision_engine_default_bucket_enabled || !candidates.length) return items;

  const toSuppress = new Set();
  for (const { item, situation, evidence } of candidates.slice(0, maxCalls)) {
    // Best-effort widening only: a failure here must never block the
    // decision itself — same discipline decision-evidence.js already applies
    // per-source internally. On failure, evidence falls back to exactly the
    // two hand-built items buildDefaultBucketSituation always provides —
    // today's behavior, never a broken or missing decision.
    let correlated = [];
    try {
      correlated = await gatherEvidenceFn('generic', siteId, { symptoms: situation });
    } catch (err) {
      console.warn(`[default-bucket-decision] correlated evidence gathering failed for site ${siteId}: ${err.message}`);
    }
    const combinedEvidence = correlated.length ? [...evidence, ...correlated] : evidence;

    let decision;
    try {
      decision = await decisionEngineFn(siteId, situation, combinedEvidence);
    } catch {
      continue; // LLM/DB failure — leave this item exactly as the deterministic path already built it
    }
    if (!decision) continue; // defensive: a misbehaving decisionEngineFn is the same as "no decision made"
    if (decision.action === 'do_nothing') {
      toSuppress.add(item);
      continue;
    }
    item.decisionId = decision.id;
    if (decision.action === 'investigate_further') item.decisionState = 'investigating';
  }

  return toSuppress.size ? items.filter((it) => !toSuppress.has(it)) : items;
}
