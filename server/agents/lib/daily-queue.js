import { scoreRecommendation } from './growth-scoring.js';
import { groupSizes, groupKeyFor, capGroupsGlobally, orderByRootCause } from './root-cause-groups.js';
import { SEVERITY_TIER, TIER_LABEL } from './severity-tiers.js';

// Builds the day's work queue: score every eligible recommendation, then fill
// the budget with the BEST ones rather than the first N in table order.
//
// "Up to 60 a day" used to mean "take the first 60 rows listOpenRecommendations
// returned, thinned by a flat 5-per-category cap". Since that query orders by
// `priority` (a within-one-agent-run ranking, not an absolute severity — see
// severity-tiers.js) and then recency, the day's work was effectively decided
// by which agent last ran, not by what would move the site.

// A floor of slots held for the lower tiers before merit-based filling.
//
// Without this, strict merit ordering starves them permanently: the reference
// site has ~50 tier-1/2 items and 234 tier-3 expansion items, which together
// exceed any daily budget, so a tier-4 blog or a tier-5 alt-text fix would
// never be reached on merit — not because it lost, but because the queue
// never got that far. The floors are small on purpose: they guarantee
// presence, not parity. Blogs additionally have their own cadence rules
// (ship-pacing.js) applied BEFORE this, so a floor of 2 here can never mean
// two blogs — pacing has already reduced them to at most one.
const TIER_FLOOR = {
  [SEVERITY_TIER.CRITICAL_TECHNICAL]: 0, // wins on merit; a floor would be redundant
  [SEVERITY_TIER.ON_PAGE]: 0,
  [SEVERITY_TIER.EXPANSION]: 0,
  [SEVERITY_TIER.CONTENT]: 2,
  [SEVERITY_TIER.CLEANUP]: 3,
};

// No single generator may take more than this share of one day's budget on
// the merit pass. This used to default to 0.5 (the "don't let the biggest
// backlog eat the day" rule: expand-content alone had 234 eligible
// candidates against a 60-slot budget, and pure merit ordering would hand it
// every slot that tier-1 and tier-2 work didn't claim).
//
// Set to 1 (no cap) as of 2026-09-10 per explicit product decision: a
// generator carrying a genuinely dominant backlog (GEO Signals' expand-
// content/qa-content — 472 eligible vs everything else on the site
// combined) should be free to claim as much of the day's ceiling as it
// earns on merit, not be artificially throttled back to preserve variety
// while its backlog sits unaddressed. Kept as a named, overridable constant
// (rather than deleted outright) so the "don't let one generator eat the
// day" protection can be reintroduced for a specific site/generator later
// without re-deriving this logic — TIER_FLOOR below still guarantees a
// minimum presence for the lower-severity tiers regardless of this value.
export const GENERATOR_SHARE_CAP = 1;

/**
 * @param opts { candidates, remaining, pageMetrics, learnedMap }
 * @returns { queue, deferred, report }
 *   queue    — [{ rec, score, tier, tierLabel, factors }] in execution order
 *   report   — the observability payload (also persisted on the run row)
 */
export function buildDailyQueue({
  candidates = [], remaining = 0, pageMetrics = new Map(), learnedMap = new Map(),
  declines = new Map(), baselineBudget = remaining, analystBudget = null,
  // Set<findingId> | null — when provided, restricts the analyst lane to
  // recommendations analyst-fusion.js actually fused and shipped as an 'act'
  // verdict (analyst_evidence.finding_id), rather than every recommendation
  // that merely sits on a page decline-detection flagged. Backward
  // compatible: omitted (null) falls back to `item.declining`, the original
  // behavior, so a site with no fusion evidence yet (or a caller in a test)
  // is unaffected. This is what makes "only evidence-backed recommendations
  // qualify" for the 20/day lane an enforced fact rather than a convention —
  // see auto-remediation.js for how the set is built.
  analystFindingIds = null,
} = {}) {
  const sizes = groupSizes(candidates);
  const scored = candidates.map((rec) => ({
    rec,
    ...scoreRecommendation(rec, { pageMetrics, learnedMap, groupSizes: sizes, groupKeyFor, declines }),
  })).sort((a, b) => b.score - a.score);

  if (remaining <= 0 || scored.length === 0) {
    return { queue: [], deferred: scored, report: emptyReport(scored) };
  }

  // Group-cap the WHOLE pool before selection, not just whatever the budget
  // passes happen to pick — see capGroupsGlobally's own comment for the real
  // shortfall (60-slot day, 59 selected) this ordering fixes. `pool` is what
  // every selection pass below draws from; `scored` (all candidates) is kept
  // only for the "eligible" reporting numbers.
  const { capped: pool, deferred: groupCapDeferred, notes: groupCapNotes } = capGroupsGlobally(scored);

  const selected = [];
  const takenIds = new Set();
  const perGenerator = new Map();

  // `lane` is stamped at SELECTION, never inferred later from whether the
  // item happens to be on a declining page. A declining page's fix that did
  // not win a reserved slot is ordinary analytics work competing on merit,
  // and counting it as analyst work would make the lane totals lie — the two
  // lanes have to stay separately observable to mean anything.
  const take = (item, lane = 'analytics') => {
    selected.push(Object.assign(item, { lane }));
    takenIds.add(item.rec.id);
    const gen = item.rec.recommendation_type;
    perGenerator.set(gen, (perGenerator.get(gen) || 0) + 1);
  };

  // THE ANALYST LANE — reserved capacity, not leftover capacity.
  //
  // Sized by the caller from real evidence (auto-remediation.js), so it is
  // empty on a day with nothing forward-looking to do. Reserved because the
  // analytics backlog is effectively unbounded — 236 eligible expand-content
  // items alone — and open merit would hand every slot to routine remediation
  // and never ship the preventive work the lane exists for.
  //
  // `analystBudget` is passed explicitly rather than inferred as
  // `remaining - baselineBudget`: once both lanes are clamped by a combined
  // ceiling that difference stops equalling the lane, and the reservation
  // would silently shrink on exactly the busiest days.
  const analystLaneSize = analystBudget ?? Math.max(0, remaining - baselineBudget);
  let analystPlaced = 0;
  if (analystLaneSize > 0) {
    for (const item of pool) {
      if (analystPlaced >= analystLaneSize || selected.length >= remaining) break;
      if (takenIds.has(item.rec.id)) continue;
      const laneEligible = analystFindingIds
        ? (item.rec.finding_ids || []).some((fid) => analystFindingIds.has(fid))
        : item.declining;
      if (!laneEligible) continue;
      take(item, 'analyst');
      analystPlaced++;
    }
  }
  // Routine work may not spend what the analyst lane was given. Everything
  // below fills only the analytics half, so an unfilled analyst lane shrinks
  // the day rather than leaking its slots to the backlog — that is what keeps
  // "up to 20, not required to be filled" honest.
  const analyticsCeiling = Math.max(0, remaining - analystLaneSize);
  const analyticsLimit = analyticsCeiling + analystPlaced;

  // Pass 0 — reserve floor slots WITHOUT letting them starve higher-tier
  // work on a short run. The real backlog this was built against has ~480
  // tier 1-3 candidates against a 60-item budget, i.e. the urgent backlog
  // ALWAYS exceeds the budget — so capping the floor reservation to
  // "whatever's left after every urgent candidate" would round to zero on
  // every single real run and silently disable the floor entirely, the
  // opposite of what it exists for. The floor's actual job is protecting a
  // SHORT run (a small remaining budget) from being entirely consumed by
  // floor-less tiers, not competing candidate-for-candidate against a
  // backlog that will always be larger. So the cap is structural, not
  // candidate-counted: floors may claim at most half of the day's budget,
  // guaranteeing urgent (tier 1-3) work always gets at least the other half
  // — on a normal-sized day (60) that leaves floors their full 5-slot
  // reservation untouched; on a 1-slot day it correctly reserves nothing,
  // fixing the case that motivated this pass in the first place.
  const totalFloorWanted = Object.values(TIER_FLOOR).reduce((sum, f) => sum + f, 0);
  let floorBudgetLeft = Math.min(Math.floor(analyticsCeiling / 2), totalFloorWanted);

  // Pass 1 — tier floors, best-first within each tier, bounded by the
  // reservation computed above rather than the raw floor number.
  for (const [tier, floor] of Object.entries(TIER_FLOOR)) {
    if (floor <= 0 || floorBudgetLeft <= 0) continue;
    let placed = 0;
    const cap = Math.min(floor, floorBudgetLeft);
    for (const item of pool) {
      if (placed >= cap || selected.length >= analyticsLimit) break;
      if (takenIds.has(item.rec.id) || item.tier !== Number(tier)) continue;
      take(item);
      placed++;
      floorBudgetLeft--;
    }
  }

  // Pass 2 — merit, subject to the per-generator share cap.
  const generatorCap = Math.max(1, Math.floor(analyticsCeiling * GENERATOR_SHARE_CAP));
  for (const item of pool) {
    if (selected.length >= analyticsLimit) break;
    if (takenIds.has(item.rec.id)) continue;
    if ((perGenerator.get(item.rec.recommendation_type) || 0) >= generatorCap) continue;
    take(item);
  }

  // Pass 3 — fill any capacity the cap left behind. "Up to N" must mean N
  // whenever N eligible items exist.
  for (const item of pool) {
    if (selected.length >= analyticsLimit) break;
    if (takenIds.has(item.rec.id)) continue;
    take(item);
  }

  // Co-located fixes run consecutively so each reads the previous one's write
  // through the batch file overlay (see root-cause-groups.js). A defensive
  // no-op on the per-group cap here — `selected` was drawn from `pool`,
  // which capGroupsGlobally above already limited — so `groupDeferred` is
  // expected to be empty; kept only so a future change to either module
  // can't silently regress this without a signal.
  const { ordered, deferred: groupDeferred, notes: consecutiveNotes } = orderByRootCause(selected);
  const queue = ordered;
  const queuedIds = new Set(queue.map((i) => i.rec.id));
  const deferred = [...groupDeferred, ...scored.filter((i) => !queuedIds.has(i.rec.id) && !groupDeferred.includes(i))];
  const groupNotes = [...groupCapNotes, ...consecutiveNotes];

  return { queue, deferred, report: buildReport({ scored, queue, deferred, remaining, generatorCap, groupNotes }) };
}

function distribution(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function emptyReport(scored) {
  return {
    eligible: scored.length, selected: 0, skipped: scored.length,
    byTier: {}, byGenerator: {}, topSelected: [], skipReasons: {}, groupNotes: [],
  };
}

function buildReport({ scored, queue, deferred, remaining, generatorCap, groupNotes }) {
  // Why each deferred item lost, in the terms the selector actually used —
  // this is what answers "why was X selected instead of Y".
  const skipReasons = {};
  const lowestSelected = queue.length ? queue[queue.length - 1].score : null;
  for (const item of deferred) {
    const reason = queue.length >= remaining
      ? (lowestSelected != null && item.score < lowestSelected
          ? `outranked — score ${item.score} below the day's cut-off ${lowestSelected}`
          : 'budget full')
      : 'held by a selection rule (generator share cap or group cap)';
    skipReasons[reason] = (skipReasons[reason] || 0) + 1;
  }

  return {
    eligible: scored.length,
    selected: queue.length,
    skipped: deferred.length,
    budget: remaining,
    generatorCap,
    // Lane composition is reported so a run row answers "how much of today
    // was prevention?" without re-deriving it from the queue.
    byLane: distribution(queue, (i) => i.lane || 'analytics'),
    byTier: distribution(queue, (i) => i.tierLabel),
    byGenerator: distribution(queue, (i) => i.rec.recommendation_type),
    eligibleByTier: distribution(scored, (i) => TIER_LABEL[i.tier] || 'unknown'),
    // Enough of the ranking to reconstruct a decision after the fact, without
    // writing 60 full factor lists into every run row.
    topSelected: queue.slice(0, 10).map((i) => ({
      id: i.rec.id, type: i.rec.recommendation_type, score: i.score,
      tier: i.tierLabel, page: i.rec.params?.page || i.rec.page || null,
      factors: i.factors,
    })),
    topSkipped: deferred.slice(0, 5).map((i) => ({
      id: i.rec.id, type: i.rec.recommendation_type, score: i.score, tier: i.tierLabel,
    })),
    skipReasons,
    groupNotes,
  };
}
