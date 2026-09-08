// THE ONE PLACE the autonomous day's size is decided, for every lane and
// every source.
//
// It used to live as four constants inside agents/lib/auto-remediation.js,
// which made two things structurally impossible to keep true:
//
//   1. "100 is the absolute ceiling" — the old COMBINED_MAX was 120, and its
//      own comment sanctioned "100 + 20" as a valid day. Analytics could
//      stretch to its own 100 while the analyst lane added 20 on top.
//   2. "across ALL autonomous sources" — the day's spend was counted as
//      drafts with source='auto-remediation' alone, so learned-repair's and
//      the content-gap lane's drafts were invisible to the budget that was
//      supposed to bound them. Two lanes shipping 60 each stayed "within
//      budget" as far as either one could tell.
//
// Both are properties of the PLATFORM's autonomous shipping, not of one
// module, so they live here and every producer imports them.
//
// THE NUMBERS.
//
//   Analytics normal allocation      60
//   Data Analyst normal allocation   20
//   ------------------------------------
//   Normal target                    80
//   Overflow ceiling (hard)         100
//
// The normal target is an INTENTION, never a quota: a day with 12 genuinely
// eligible findings ships 12, and nothing is manufactured or quality-relaxed
// to reach 80. Overflow is the opposite direction — when more genuinely
// eligible, already-validated work exists than the target covers, the day may
// stretch to 100 TOTAL rather than deferring good work for no reason.
//
// 100 is a hard stop, not a target to fill: every shipped item costs several
// GitHub API calls against a 5,000/hour token budget shared across sites, and
// rate limiting is already the largest single abandon cause in the live
// drafts table. Excess eligible work stays queued for the next day — it is
// never dropped (see lib/shipping-queue.js).

// Every draft `source` that represents AUTONOMOUS shipping, i.e. work no
// human asked for item by item. All of them draw from the same daily
// ceiling; a source missing from this list is a source that can exceed it.
//
// Deliberately NOT included: 'action-center' / null (a human clicking
// Generate or Execute Safe Fixes — a person asking for a batch is not the
// runaway this ceiling exists to catch), and 'code-self-repair' (it repairs
// THIS platform's own repository, never a tenant's, and is the one explicit
// exception to the shared-pipeline rule).
export const AUTONOMOUS_DRAFT_SOURCES = Object.freeze([
  'auto-remediation',
  'analyst-keyword-gap',
  'learned-repair',
  'content-repair',
  'template-capability-repair',
  'design-agent',
]);

export const ANALYTICS_TARGET = Number(process.env.AUTO_REMEDIATION_ANALYTICS_TARGET) || 60;
export const ANALYST_MAX = Number(process.env.AUTO_REMEDIATION_ANALYST_MAX) || 20;
export const NORMAL_TARGET = ANALYTICS_TARGET + ANALYST_MAX;
// The absolute ceiling across both lanes and every source above. An env
// override is accepted (an operator holding the whole platform lower is a
// legitimate need) but it can only ever LOWER the ceiling — raising it past
// the documented hard stop is refused, because "100 is absolute" stops being
// true the moment a stray environment variable can move it.
export const HARD_CEILING = (() => {
  const raw = Number(process.env.AUTO_REMEDIATION_COMBINED_MAX);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 100) : 100;
})();

/**
 * Size both lanes for one site's day.
 *
 * Pure — every input is a plain number, so the ceiling arithmetic is
 * testable without a database, a site, or a clock. The caller supplies real
 * counts of ALREADY-ELIGIBLE work (post-pacing, post-convergence,
 * post-refusal); this function never asks what the work is, only how much of
 * it the day may take.
 *
 * @param {object} o
 * @param {number} o.analyticsCandidates  eligible analytics-lane items
 * @param {number} o.analystCandidates    eligible, evidence-backed analyst items
 * @param {number|null} [o.siteLimitOverride] sites.auto_remediation_daily_limit —
 *   an explicit per-site cap on the TOTAL day when set (0 pauses the tenant).
 * @param {number} [o.spentToday]  autonomous drafts this site already shipped today,
 *   counted across every AUTONOMOUS_DRAFT_SOURCES lane.
 * @param {number} [o.globalRemaining] platform-wide headroom left today.
 * @returns {{ analyticsBudget, analystBudget, dailyLimit, remaining, ceiling, target }}
 */
export function laneBudgets({
  analyticsCandidates = 0,
  analystCandidates = 0,
  siteLimitOverride = null,
  spentToday = 0,
  globalRemaining = Infinity,
} = {}) {
  // An explicit per-site override caps the whole day, both lanes together.
  // It can only tighten: a site configured to 200 does not get to exceed the
  // platform's hard ceiling, which is the entire point of calling it hard.
  const ceiling = siteLimitOverride != null
    ? Math.max(0, Math.min(siteLimitOverride, HARD_CEILING))
    : HARD_CEILING;

  // The analyst lane is sized FIRST and protected. The analytics backlog is
  // effectively unbounded (one live site carries 236 eligible expand-content
  // items alone), so letting it claim the ceiling first would silently close
  // the analyst lane on exactly the busy days prevention matters most.
  const analystBudget = Math.min(ANALYST_MAX, Math.max(0, analystCandidates), ceiling);

  // Analytics takes its normal allocation, then stretches into whatever the
  // ceiling still allows once the analyst lane has been reserved — that
  // stretch IS the overflow capacity. With a full analyst lane the most
  // analytics can ever take is 100 - 20 = 80, which is what makes
  // "never 100 analytics + 20 analyst" structurally impossible rather than a
  // convention.
  const analyticsCeiling = Math.max(0, ceiling - analystBudget);
  const analyticsBudget = Math.min(Math.max(0, analyticsCandidates), analyticsCeiling);

  const dailyLimit = analyticsBudget + analystBudget;
  // What is still shippable RIGHT NOW, after everything already shipped
  // today by any autonomous source and whatever the platform-wide ceiling
  // has left. This is the number that makes retries, catch-up passes,
  // duplicate workers and restarts unable to bypass the ceiling: each of
  // them re-derives it from the same persisted count rather than being
  // granted a fresh day.
  const remaining = Math.max(0, Math.min(dailyLimit - spentToday, ceiling - spentToday, globalRemaining));

  return {
    analyticsBudget,
    analystBudget,
    dailyLimit,
    remaining,
    ceiling,
    target: Math.min(NORMAL_TARGET, ceiling),
  };
}
