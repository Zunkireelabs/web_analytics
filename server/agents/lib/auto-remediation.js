import { listOpenRecommendations, closeRecommendation } from '../../store/recommendations.js';
import { getDraft, getDraftedFindingIds, getPendingDraftFilePaths, submitDraftForApproval, updateDraft, markDraftAbandoned, recordMergeFailure } from '../../store/drafts.js';
import { getSiteById } from '../../store/read.js';
import { resolveFile } from '../../implementers/lib/url-file-map.js';
import { generateDraft, approveAndPublishDraftUnattended, autoSelectMetaTitle, finalizeBatchPr, pushDraftBranch, openDraftPr } from '../../routes/action-center.js';
import { batchBranchName, beginBatchPush } from '../../implementers/lib/github-ops.js';
import { classifyRecommendation, AUTONOMY_DECISION } from './autonomy-decision.js';
import { getLearnedConfidenceMap, recordOutcome } from './generator-learning.js';
import { maybeEscalateToCodeRepair } from './code-self-repair.js';
import { isOnboardingAnalysisPending } from '../../implementers/lib/onboarding-readiness.js';
import { applyPacing, applyConvergenceCap, applyRefusalCap } from './ship-pacing.js';
import { getLastKnownRateLimit, RATE_LIMIT_RESERVE } from '../../github/client.js';
import { buildDailyQueue } from './daily-queue.js';
import { loadDeclines } from './decline-detection.js';
import { listActionableAnalystEvidence } from '../../store/analyst-evidence.js';
import { buildPageMetrics } from './growth-scoring.js';
import { classifyShipFailure, failureFamilyKey, FAILURE_KIND, SYSTEMIC_FAILURE_LIMIT, FAMILY_FAILURE_LIMIT } from './failure-policy.js';
import { getQueryPageMetrics } from '../../store/read.js';
import { draftShipState, SHIP_STATE } from '../../lib/draft-ship-state.js';
import { NO_FILE_MAPPING_FRAGMENT, NO_MARKERS_CONFIGURED_FRAGMENT, UNVERIFIED_PLACEHOLDER_FRAGMENT } from '../../lib/draft-failure-phrases.js';
import { recordAutoRemediationRun } from '../../store/auto-remediation-runs.js';
import { laneBudgets, ANALYST_MAX, AUTONOMOUS_DRAFT_SOURCES } from '../../lib/autonomous-quota.js';
import { countDraftsBySourcesToday } from '../../store/drafts.js';
import { listByState as listQueueItemsByState, markShipped as markQueueItemShipped, releaseItem as releaseQueueItem, countShippedFileEditsToday, QUEUE_STATES } from '../../store/shipping-queue.js';
import { recordFixOutcome } from '../../agent-memory.js';
import { sanitizeForCustomer } from '../../lib/errors.js';

const SOURCE = 'auto-remediation';

// The all-purpose "5 consecutive failures of ANY kind stop the whole run"
// breaker this used to be lived here. Replaced by two narrower, correct
// mechanisms in failure-policy.js:
//   - SYSTEMIC_FAILURE_LIMIT (consecutive SYSTEMIC failures only — a revoked
//     token, a dead database, a gone repo) still stops the run, because every
//     later item genuinely shares that fault.
//   - FAMILY_FAILURE_LIMIT quarantines one repeating INDIVIDUAL failure shape
//     (e.g. "no services.X entry in locations.js") for the rest of the run,
//     without touching anything else — the old breaker's real failure mode:
//     a cluster of unrelated per-item config gaps sorting together by
//     priority could halt a 60-item day at item five with ~55 shippable
//     items untouched. See failure-policy.js for the reasoning in full.

// The refusal counterpart, and deliberately much looser.
//
// A refusal is the no-fabrication policy working, so refusing is never wrong
// and must never trip the failure breaker. But a long unbroken run of them
// still means this site has nothing it can honestly ship right now, and
// grinding through the rest of a 30-item budget to refuse each one costs a
// generation call apiece and buries the signal. Stopping at 8 keeps the run
// cheap while staying far enough above the "a few unlucky items in a row"
// range that a genuinely productive day is never cut short.
//
// Reported as its own stoppedReason, never as 'circuit-breaker': to an
// operator those mean opposite things. One says the system is broken; this
// one says the system is working and correctly has nothing to say.
const CONSECUTIVE_REFUSAL_LIMIT = 8;

// The credential-resolution failures worth one automatic in-run retry before
// they become a real outcome — see shipDraftForRecommendation's own comment
// for the incident this answers. Matches client.js's authHeaders messages for
// all three credential paths (App, per-site PAT, code-search PAT), since any
// of them failing once and then resolving is the same "unexplained blip"
// shape, and one retry distinguishes that from a genuinely absent credential.
const CREDENTIAL_FAILURE_PATTERN = /GitHub App is not configured|No GitHub PAT set in env var|No classic PAT with .*scope set for code search/i;
// Env-overridable purely so tests don't pay the real wait; same pattern as
// the budget constants below.
const CREDENTIAL_RETRY_DELAY_MS = Number(process.env.CREDENTIAL_RETRY_DELAY_MS ?? 2000);

// Stage 3-4 of Generate -> Validate -> Auto-fix -> Validate again -> Action
// Center: closes the loop risk-tiers.js opened. A 'safe'-tier recommendation
// doesn't need a human to click anything — generateDraft() already runs the
// Quality Gate (generators/lib/quality-gate.js) with a bounded regeneration
// attempt, and approveAndPublishDraft() re-validates before the PR opens, so
// this function is deliberately thin: draft it, submit it, publish it, and
// let those two gates be the only thing standing between a detected issue
// and a real PR. On a Quality Gate rejection (or any other failure) the
// recommendation is simply left open — getRecommendations() only hides a
// recommendation once a draft actually exists for it, so an issue this
// couldn't safely auto-fix surfaces in the Action Center exactly like any
// other issue that "genuinely requires human judgment."
//
// Called after syncFromGrounded() from both server/job.js's daily cron and
// routes/action-center.js's refreshRecommendations() — the same two places
// that already create/refresh recommendation rows — so every path that can
// detect a safe-tier issue also gets a chance to auto-remediate it, not just
// one of them.
//
// Opt-in per site (sites.auto_remediation_enabled, migration 089) — see that
// migration's comment for why this isn't on by default.
//
// Bounded on three axes, because "unattended" and "unbounded" are not the
// same thing and this loop runs against real customer repositories:
//   1. Daily budget — sites.auto_remediation_daily_limit (migration 101,
//      default 30), counted in the SITE'S timezone. Before this existed the
//      loop had no cap at all and would have fired every open safe-tier
//      recommendation in a single pass the first morning it was enabled.
//   2. Failure handling — SYSTEMIC_FAILURE_LIMIT / FAMILY_FAILURE_LIMIT, see
//      failure-policy.js.
//   3. Risk tier — only 'safe' generators, which now also excludes anything
//      the design-verification gate blocked (those are demoted to 'manual').
//
// It ends at an OPEN PULL REQUEST and never merges — see finalizeBatchPr's
// call below for why that boundary is deliberate rather than incidental.
// globalRemaining: an optional platform-wide ceiling on top of this site's
// own budget (server/job.js's AUTO_REMEDIATION_GLOBAL_DAILY_CEILING) — see
// that file for how it's tracked across sequential per-site calls in one
// cron pass. Defaults to Infinity (no change in behavior) for every other
// caller (routes/action-center.js's executeSafeFixes, a human-triggered
// batch, is never subject to it — same reasoning as pacing above, a human
// asking for a batch isn't the runaway this ceiling exists to catch).

// TWO LANES, ONE HARD CEILING.
//
// The day is not one budget. It is an ANALYTICS lane for routine remediation
// findings and an ANALYST lane for forward-looking growth and prevention, and
// they are counted separately so each stays observable on its own.
//
// The actual sizing arithmetic lives in lib/autonomous-quota.js — a single,
// pure, unit-tested module shared by every autonomous producer (see that
// file's own header for the full numbers and why 100 is an absolute ceiling
// across both lanes AND every autonomous source, not per-lane). This module
// used to own its own copy of these constants (ANALYTICS_MAX=100,
// COMBINED_MAX=120), which made "100 + 20 = 120" a documented, intentional
// possibility — directly contradicting "100 is the absolute hard ceiling
// across ALL autonomous sources." laneBudgets() below is what makes that
// combination structurally unreachable instead of merely undocumented.

export async function autoRemediateSafeRecommendations(siteId, {
  globalRemaining = Infinity,
  onboardingAnalysisPending = isOnboardingAnalysisPending,
} = {}) {
  const site = await getSiteById(siteId);
  // No site row to attribute a run log to (auto_remediation_runs.site_id is a
  // real FK) — nothing to record, same 'disabled' outcome as the flag being off.
  if (!site) return { attempted: 0, shipped: 0, failed: 0, skipped: 0, stoppedReason: 'disabled' };

  // Human-facing label for this run's log lines. client_number is the small
  // sequential onboarding number (1, 2, 3...) shown to people; the real
  // sites.id primary key (e.g. 8862) is never sequential and isn't what
  // anyone reading these logs is trying to track a site by.
  const clientLabel = site.client_number ? `client #${site.client_number}` : `site ${siteId}`;

  const startedAt = new Date();
  // Every exit below goes through this so `auto_remediation_runs` always has
  // a row for what a console-only log used to be the only record of — see
  // migration 136's own comment for the 2026-09-02 incident this answers.
  const finish = (result) => {
    // recordAutoRemediationRun already swallows its own errors — never blocks
    // on the write finishing.
    recordAutoRemediationRun(siteId, { startedAt, finishedAt: new Date(), ...result });
    return result;
  };

  if (!site.auto_remediation_enabled) return finish({ attempted: 0, shipped: 0, failed: 0, skipped: 0, stoppedReason: 'disabled' });

  // Two-stage onboarding: a genuinely new tenant's repo connection queues
  // ONLY the whole-site analysis job (job.js's queueDesignAgentDerivationForSite)
  // — this loop must not open a single PR until that analysis has reached a
  // terminal state, however many cron passes that takes. See
  // isOnboardingAnalysisPending's own comment for exactly what "pending"
  // means and why a site that predates this gate is never newly blocked.
  if (await onboardingAnalysisPending(site)) {
    return finish({ attempted: 0, shipped: 0, failed: 0, skipped: 0, stoppedReason: 'onboarding-analysis-pending' });
  }

  const [rows, draftedFindingIds, pendingDraftFilePaths, draftsSpentToday, fileEditsSpentToday, learnedMap] = await Promise.all([
    listOpenRecommendations(siteId),
    getDraftedFindingIds(siteId),
    getPendingDraftFilePaths(siteId),
    // Counted across EVERY autonomous shipping lane that ends in a real
    // `drafts` row (auto-remediation, analyst-keyword-gap, learned-repair,
    // design-agent — see AUTONOMOUS_DRAFT_SOURCES). Two lanes each measuring
    // only their own spend against the shared ceiling is exactly how "100
    // total" used to become "100 + 20" in practice.
    countDraftsBySourcesToday(siteId, AUTONOMOUS_DRAFT_SOURCES, site.timezone || 'UTC'),
    // content-repair and template-capability-repair ship file edits straight
    // through shipping_queue (kind: 'file-edits') and never create a `drafts`
    // row at all — countDraftsBySourcesToday above is structurally blind to
    // them. countShippedFileEditsToday is the queue's own count of exactly
    // that slice, and only that slice: `kind: 'draft'` queue items
    // (learned-repair) are deliberately excluded here because they already
    // land in draftsSpentToday once shipped, and summing both counts would
    // count the same fix twice.
    countShippedFileEditsToday(siteId, site.timezone || 'UTC'),
    // Phase 5: real outcome history for this site, read once per run. A
    // generator whose recent real attempts have repeatedly failed or been
    // rejected is excluded here — not just reported differently elsewhere —
    // which is what makes learning actually change behavior rather than
    // only change what gets displayed.
    getLearnedConfidenceMap(siteId).catch(() => new Map()),
  ]);
  // The shared ceiling's real spend for today: every autonomous fix shipped
  // by ANY source, whether it produced a `drafts` row or a file-edits queue
  // row, counted exactly once each (see the two comments above).
  const spentToday = draftsSpentToday + fileEditsSpentToday;
  // blocked_reason is checked HERE rather than trusted to be reflected in
  // risk_tier. The previous comment argued the check was redundant because
  // recommendation-coordinator.js demotes every blocked recommendation to
  // 'manual' — but the live table disagrees: site 1 currently has 45 open
  // rows with risk_tier='safe' AND a non-null blocked_reason, re-detected as
  // recently as this morning's run. Whatever writes them, the effect is that
  // this loop would draft an item generateDraft is guaranteed to 422, three
  // in a row would trip the circuit breaker, and the site's whole run would
  // stop early having shipped nothing.
  //
  // A blocked recommendation is exactly what "unattended must not touch this"
  // means, so the unattended path now asks the question directly instead of
  // inferring the answer from a second column that can disagree.
  //
  // classifyRecommendation is the SAME function Phase 4's decision layer and
  // the Assistant use — this loop's own eligibility and "what would the
  // Assistant tell you is safe" can never quietly disagree with each other.
  //
  // The pendingDraftFilePaths check is the file-level sibling to the
  // finding_id check above: it stops THIS run from drafting a DIFFERENT
  // finding against a file that already has an earlier finding's draft
  // sitting on a still-open, unmerged Action Center PR (see
  // getPendingDraftFilePaths' own comment — batchBranchName forks a fresh
  // branch every day regardless of whether yesterday's PR merged, so without
  // this a second day's run silently regenerates the same file from stale
  // content and clobbers/reverts the first day's still-pending draft).
  const eligible = rows.filter((r) => classifyRecommendation(r, learnedMap).decision === AUTONOMY_DECISION.SAFE_TO_AUTO_EXECUTE
    && r.finding_ids.every((fid) => !draftedFindingIds.has(fid))
    && !pendingDraftFilePaths.has(resolveFile(site, r.page)));

  // Publishing cadence, applied BEFORE the daily budget so a paced generator
  // can't consume budget slots it isn't due for.
  //
  // This used to be the unattended path's alone, on the reasoning that a
  // human clicking "Execute Safe Fixes" is deliberately asking for a batch
  // and doesn't need the agent's sense of rhythm imposed on them. Real usage
  // disproved that: three bulk runs on 2026-09-01 produced 61 blog-outline
  // drafts and opened one PR carrying 42 net-new blog posts. The click asks
  // for a batch of FIXES; it was never a decision to publish a quarter's
  // worth of blog content at once. Both paths now share this via
  // ship-pacing.js.
  const { paced, notes: pacingNotes } = await applyPacing(site, eligible);
  for (const note of pacingNotes) console.log(`[auto-remediation] ${clientLabel}: ${note}`);

  // Convergence cap: a finding that has already failed this many times for an
  // item-specific reason stops being auto-drafted. It stays open and fully
  // visible — what stops is spending a model call per run to reach the same
  // error. See ship-pacing.js for the measured churn this ends.
  const { converged, notes: convergenceNotes } = await applyConvergenceCap(site, paced);
  for (const note of convergenceNotes) console.log(`[auto-remediation] ${clientLabel}: ${note}`);

  // Refusal cap: the convergence cap above counts abandoned DRAFTS, and a
  // refusal never creates one, so a permanently-refusing item slipped past
  // both it and the learned score. See applyRefusalCap for the live case (one
  // item refused 22 times, re-attempted hourly).
  const { kept: candidates, notes: refusalNotes } = await applyRefusalCap(site, converged);
  for (const note of refusalNotes) console.log(`[auto-remediation] ${clientLabel}: ${note}`);

  // Daily budget. `remaining` can go negative if the limit was lowered
  // mid-day after work was already done — Math.max keeps that a clean "no
  // budget left" rather than a negative slice that would silently take
  // everything. Also capped by the platform-wide ceiling (globalRemaining),
  // when the caller supplied one — whichever is tighter wins.
  // ADAPTIVE BUDGET. The site's configured limit is the BASELINE, not the
  // ceiling: when the eligible backlog is deep enough that a baseline day
  // would leave most of it untouched, the day surges to SURGE_DAILY_LIMIT.
  //
  // The point is to drain a backlog at the rate it actually accumulates
  // without paying for that capacity on quiet days — a flat 80 would spend
  // GitHub API budget and model calls chasing work that isn't there, and a
  // flat 60 can never catch up on a site carrying 500+ open items.
  //
  // Measured against `candidates` (post-pacing, post-convergence, post-refusal
  // — i.e. genuinely shippable work), never against raw open rows, so a
  // backlog made entirely of held or demoted items can't trigger a surge that
  // would then find nothing to do with the extra slots.
  // What the analyst found losing ground, and which of today's candidates sit
  // on those pages. Never fatal: a site with no GSC history, or an outage,
  // simply runs a normal 60 day — the same posture the metrics fetch below
  // already takes.
  const { declines, siteWide } = await loadDeclines(siteId, { timezone: site.timezone || 'UTC' }).catch((err) => {
    console.warn(`[auto-remediation] ${clientLabel}: decline detection unavailable (${err.message}) — running a baseline day with no analyst lane.`);
    return { declines: new Map(), siteWide: null };
  });

  // EVIDENCE-BACKED LANE MEMBERSHIP. analyst-fusion.js's nightly pass
  // (job.js's runAnalystFusionForAllSites) already corroborated signals
  // across decline-detection, the insight pipeline and growth-opportunities,
  // gated on real input freshness, and recorded every conclusion that
  // cleared the bar in analyst_evidence with verdict='act'. That table —
  // not "any recommendation whose page happens to be in declines" — is the
  // authority for which of today's candidates are genuinely evidence-backed,
  // which is what "never manufacture weak Analyst recommendations to fill
  // the quota" requires in practice: a page can be in `declines` on ONE
  // signal alone (decline-detection's own threshold), which fusion would
  // correctly leave at 'monitor', not 'act', if nothing else corroborates it.
  //
  // Falls back to the raw declines Map when fusion has not run for this site
  // yet (a brand-new site, or before the first nightly pass) — never a hard
  // dependency, same posture as every other Analyst integration point.
  const actEvidence = await listActionableAnalystEvidence(siteId).catch(() => []);
  const analystFindingIds = actEvidence.length ? new Set(actEvidence.map((e) => e.finding_id)) : null;
  const decliningCandidates = analystFindingIds
    ? candidates.filter((r) => (r.finding_ids || []).some((fid) => analystFindingIds.has(fid)))
    : candidates.filter((r) => declines.has(r.params?.page || r.page));
  if (siteWide?.siteIsDown) {
    // Reported, never acted on by mass-shipping. detectDeclines already
    // measures every page RELATIVE to this site-wide move, so a uniform fall
    // marks no individual page — which is correct: no page edit fixes an
    // algorithm update, and opening 80 PRs at one would add risk, not traffic.
    console.warn(`[auto-remediation] ${clientLabel}: SITE-WIDE impressions down ${Math.abs(Math.round(siteWide.impressionsChangePct * 100))}% (${siteWide.priorImpressions} -> ${siteWide.currentImpressions}) — per-page declines are measured net of this, so only pages falling faster than the site are escalated.`);
  }

  // Lane sizing — delegated entirely to lib/autonomous-quota.js's
  // laneBudgets(), the single place both numbers (60/20 normal, 100 hard
  // ceiling across every autonomous source) are decided. `site.
  // auto_remediation_daily_limit` still works as an explicit per-site
  // override (laneBudgets' siteLimitOverride) — it can only ever TIGHTEN the
  // day, never raise it past the platform's hard ceiling, which is what
  // makes an operator's override actually mean "never more than this."
  // Fetched here, BEFORE budget sizing, so their demand is real input to
  // laneBudgets — not an afterthought squeezed into whatever headroom
  // happened to survive ordinary analytics selection. Without this, a day
  // with zero open recommendations but real queued learned-repair/
  // file-edits work computed remaining=0 from analyticsCandidates=0 alone
  // and returned before the drain code below ever ran, silently leaving
  // genuinely prepared, already-validated work unshipped.
  const learnedRepairQueueItems = (await listQueueItemsByState(siteId, QUEUE_STATES.QUEUED)).filter((r) => r.source === 'learned-repair');
  // Every producer that queues its own PRE-COMPUTED, already-validated file
  // edits rather than a draft — content-repair (repair-site-content-live.js)
  // and template-capability-repair (repair-template-capability.js). Both
  // share the identical shape (params.edits, params.commitMessage) and the
  // identical drain treatment below, so they are not distinguished by
  // source here — only by `kind`.
  const fileEditsQueueItems = (await listQueueItemsByState(siteId, QUEUE_STATES.PREPARED)).filter((r) => r.kind === 'file-edits');
  const sharedQueueDemand = learnedRepairQueueItems.length + fileEditsQueueItems.length;

  const analyticsCandidates = candidates.length - decliningCandidates.length + sharedQueueDemand;
  const { analyticsBudget, analystBudget, dailyLimit, remaining, ceiling, target } = laneBudgets({
    analyticsCandidates,
    analystCandidates: decliningCandidates.length,
    siteLimitOverride: site.auto_remediation_daily_limit,
    spentToday,
    globalRemaining,
  });

  console.log(
    `[auto-remediation] ${clientLabel}: capacity — analytics ${analyticsBudget} `
    + `(${analyticsCandidates} eligible), analyst ${analystBudget}/${ANALYST_MAX} `
    + `(${decliningCandidates.length} evidenced), total ${dailyLimit}/${ceiling} (spent today across every `
    + `autonomous lane: ${spentToday}).`
  );
  if (dailyLimit < target) {
    console.log(`[auto-remediation] ${clientLabel}: only ${dailyLimit} genuinely eligible item(s) available against the ${target} normal target — shipping all of them rather than padding to reach it.`);
  }
  if (remaining === 0) {
    // A dailyLimit of 0 from zero genuinely eligible candidates is not the
    // same fact as a real budget cap being reached — nothing was ever
    // going to be attempted today, so there is nothing to report as
    // "exhausted" or "ceiling-reached". Both of those imply real, present
    // work that the budget stopped; stoppedReason stays null (the same
    // "skipped, never attempted-and-failed" contract every other
    // ineligibility path in this function already honors) so a caller can't
    // mistake an empty queue for a stopped run.
    const reason = candidates.length === 0 ? null : (spentToday >= dailyLimit ? 'budget-exhausted' : 'global-ceiling-reached');
    console.log(`[auto-remediation] ${clientLabel} has no budget left this run (${spentToday}/${dailyLimit} site budget used${globalRemaining < Infinity ? `, ${globalRemaining} left in the platform-wide ceiling` : ''}) — nothing attempted.`);
    return finish({ attempted: 0, shipped: 0, failed: 0, skipped: candidates.length, spentToday, dailyLimit, stoppedReason: reason });
  }

  // GROWTH-VALUE SELECTION. The day's queue is built, scored and ranked
  // before a single item executes — see daily-queue.js for the passes and
  // growth-scoring.js for what each factor is worth.
  //
  // Replaces a sort on `priority` then `expected_impact.value`. Both inputs
  // were unsound: `priority` is assigned by priorityByRank as thirds within
  // ONE agent's own run (so two agents' 'high' are not the same claim), and
  // `expected_impact.value` carries a different unit per agent — impressions
  // here, an affected-item count there, a percentage elsewhere — so
  // multiplying it across generators compared unlike quantities. The
  // 5-per-category cap it fed is gone too: it thinned by Action Center
  // display category, which is a UI grouping, and three real sources
  // (growth-opportunities, analyst-insights, analyst-keyword-gaps) match no
  // taxonomy key at all and so shared one cap between them.
  //
  // Real GSC metrics are fetched per run and keyed by page. Failure is not
  // fatal: an empty map simply means every item scores on severity, breadth
  // and confidence alone, which is already the case for the ~80% of pages
  // that have no measured demand (see growth-scoring.js's thin-data note).
  const metricsEnd = new Date();
  const metricsStart = new Date(metricsEnd.getTime() - 28 * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const pageMetrics = await getQueryPageMetrics(siteId, iso(metricsStart), iso(metricsEnd), { minImpressions: 1 })
    .then(buildPageMetrics)
    .catch((err) => {
      console.warn(`[auto-remediation] ${clientLabel}: GSC metrics unavailable for scoring (${err.message}) — ranking on severity/breadth/confidence only.`);
      return new Map();
    });

  const { queue, deferred: selectionDeferred, report: selection } = buildDailyQueue({ candidates, remaining, pageMetrics, learnedMap, declines, analystBudget, analystFindingIds, baselineBudget: Math.max(0, analyticsBudget - spentToday) });
  const budgeted = queue.map((item) => item.rec);
  const scoreById = new Map(queue.map((item) => [item.rec.id, item]));
  for (const note of selection.groupNotes) console.log(`[auto-remediation] ${clientLabel}: ${note}`);
  console.log(
    `[auto-remediation] ${clientLabel}: queue built — ${selection.eligible} eligible, ${selection.selected} selected of ${remaining} budget. `
    + `By lane: ${JSON.stringify(selection.byLane)}. By tier: ${JSON.stringify(selection.byTier)}. By generator: ${JSON.stringify(selection.byGenerator)}.`
  );
  for (const top of selection.topSelected.slice(0, 5)) {
    console.log(`[auto-remediation] ${clientLabel}:   #${top.id} ${top.type} score=${top.score} [${top.tier}] ${top.factors.join(', ')}`);
  }
  // Never silently truncate: a run that ships 30 of 41 open issues must say
  // so, or the Action Center looks like it simply found fewer problems.
  if (budgeted.length < candidates.length) {
    console.log(`[auto-remediation] ${clientLabel}: ${candidates.length} eligible, taking ${budgeted.length} within today's budget (${spentToday}/${dailyLimit} already used); ${candidates.length - budgeted.length} deferred to tomorrow.`);
  }

  let shipped = 0;
  let failed = 0;
  // Refusals are a SUBSET of `failed` — reported separately so a run that
  // declined three items honestly is not read as three things going wrong.
  let refused = 0;
  let quarantined = 0;
  let consecutiveSystemicFailures = 0;
  let consecutiveRefusals = 0;
  let stoppedReason = null;
  let attempted = 0;

  // FAILURE HANDLING. Two independent mechanisms, not one all-purpose
  // breaker — see failure-policy.js for why the old single counter conflated
  // them:
  //
  //   1. SYSTEMIC breaker: consecutive SYSTEMIC failures (GitHub auth dead,
  //      DB unreachable, repo gone) stop the whole run — every later item
  //      shares the same fault, so stopping is correct and cheap.
  //   2. FAMILY quarantine: an individual failure shape that repeats
  //      (locations.js missing an entry, a malformed draft) never stops
  //      anything. Once a (generator, normalized-error) family has failed
  //      FAMILY_FAILURE_LIMIT times, that GENERATOR is quarantined for the
  //      rest of THIS run and the freed budget slot is backfilled from the
  //      next-best deferred candidate instead. Quarantining by generator
  //      rather than the exact family text is a deliberate, coarser choice:
  //      a not-yet-attempted item's failure shape can't be known in advance,
  //      so the only way to actually stop retrying a known-bad pattern
  //      without prescience is to treat two matching failures from the same
  //      generator as evidence about that generator's remaining candidates
  //      this run — reversed every run (a fresh Map/Set below), so a
  //      generator quarantined today is tried again tomorrow once whatever
  //      broke it is fixed.
  const familyFailureCounts = new Map(); // familyKey -> count, this run only
  const quarantinedGenerators = new Map(); // generatorId -> reason, this run only
  const quarantineNotes = [];

  // Batch the git push the same way routes/action-center.js's
  // executeSafeFixes does: every item below ships with deferPr, so its
  // commit is created but the branch ref doesn't move and no PR opens per
  // item — see github-ops.js's beginBatchPush. With a 60-item daily budget,
  // this collapses what used to be up to 60 separate pushes (each its own
  // Vercel preview build) into one, at the end of this run. Only begun when
  // there's actually something to attempt, and ALWAYS finalized below when
  // begun (even if every attempt fails and `pending` ends up empty) —
  // beginBatchPush's state is only ever cleared by a matching finalize
  // call, so skipping that call on an empty-but-begun run would leave it
  // dangling for the rest of this process's life, silently deferring any
  // later single-click push to this same branch that never gets flushed.
  const branchName = batchBranchName(site);
  // BACKFILL. `queue` already holds up to `remaining` items, but a
  // quarantined generator's slots would otherwise go unused even though
  // `deferred` may hold plenty of eligible, different-generator work — which
  // is exactly the "60 slots, only 45 attempted" shortfall this redesign
  // exists to close. `backfillPool` is every scored-but-not-selected
  // candidate, best first; consumed only when quarantine frees a slot.
  const backfillPool = [...selectionDeferred].sort((a, b) => b.score - a.score);
  let backfillCursor = 0;
  const attemptedOrQueuedIds = new Set(queue.map((item) => item.rec.id));
  const nextBackfillCandidate = () => {
    while (backfillCursor < backfillPool.length) {
      const candidate = backfillPool[backfillCursor++];
      if (attemptedOrQueuedIds.has(candidate.rec.id)) continue;
      if (quarantinedGenerators.has(candidate.rec.recommendation_type)) continue;
      attemptedOrQueuedIds.add(candidate.rec.id);
      return candidate;
    }
    return null;
  };

  // SHARED QUEUE DRAIN — the other autonomous producers that no longer open
  // their own PR (learned-repair.js, repair-site-content-live.js). Their
  // work was already decided/prepared earlier in the day (see
  // store/shipping-queue.js) and fetched above (feeding laneBudgets, so a
  // day with real queued work but zero ordinary recommendations still gets a
  // nonzero budget); this run's job is only to fold whatever fits in today's
  // remaining headroom into THIS SAME batch, so the platform still produces
  // exactly one PR. How many actually get DRAINED is capped by real
  // remaining headroom computed AFTER the main loop below (`remaining -
  // attempted`), since backfill can consume budget unpredictably up to
  // `remaining` and headroom must never be over-estimated before that's known.
  const batching = queue.length > 0 || backfillPool.length > 0 || learnedRepairQueueItems.length > 0 || fileEditsQueueItems.length > 0;
  if (batching) beginBatchPush(site, branchName);
  const pending = []; // { rec, draft }
  // Non-draft-backed batch members — content-repair's file-edits. Tracked
  // separately from `pending` because finalizeBatchPr's draftIds must be
  // real `drafts` table rows (it feeds pending[0].draft.id to openDraftPr);
  // these never create one.
  const shippedFileEditsQueueIds = [];
  let prUrl = null;
  // A mutable work queue: quarantine backfilling appends to it in place, so
  // the loop below stays a single straightforward pass over `workQueue`
  // rather than needing its own nested retry logic.
  const workQueue = [...queue];

  for (let cursor = 0; cursor < workQueue.length; cursor++) {
    const rec = workQueue[cursor].rec;

    // Known-bad generator, established earlier THIS run — skip without
    // spending an attempt, and immediately backfill the freed slot from the
    // next-best deferred candidate so "up to 60" still means 60 whenever
    // enough eligible work exists. Not counted as failed (it never ran) and
    // does not touch either streak counter.
    if (quarantinedGenerators.has(rec.recommendation_type)) {
      quarantined++;
      if (attempted < remaining) {
        const backfill = nextBackfillCandidate();
        if (backfill) workQueue.push(backfill);
      }
      continue;
    }

    if (consecutiveSystemicFailures >= SYSTEMIC_FAILURE_LIMIT) {
      stoppedReason = 'circuit-breaker-systemic';
      console.error(`[auto-remediation] ${clientLabel}: ${SYSTEMIC_FAILURE_LIMIT} consecutive SYSTEMIC failures (infrastructure, not individual items) — stopping this site's run. ${workQueue.length - cursor} candidate(s) left untouched and still open.`);
      break;
    }
    if (consecutiveRefusals >= CONSECUTIVE_REFUSAL_LIMIT) {
      stoppedReason = 'refusal-streak';
      console.log(`[auto-remediation] ${clientLabel}: ${CONSECUTIVE_REFUSAL_LIMIT} consecutive honest refusals — nothing here can be drafted without fabricating, so stopping rather than spending the rest of the budget proving it. ${workQueue.length - cursor} candidate(s) left untouched and still open. This is not a fault.`);
      break;
    }
    // Stop STARTING new items once GitHub's remaining budget is under the
    // reserve. Deliberately a pre-check rather than only reacting to the
    // first 403: an item that begins near the floor burns a generation call
    // and several writes before failing at the push, so the cheapest place
    // to notice is before the attempt. The items left here stay open and
    // untouched for the next pass — nothing is consumed, so this costs one
    // deferred day at worst, against the whole-run collapse it prevents.
    if (getLastKnownRateLimit(site).low) {
      stoppedReason = 'github-rate-limited';
      console.warn(`[auto-remediation] ${clientLabel}: GitHub API budget under the ${RATE_LIMIT_RESERVE}-request reserve — stopping before starting more work. ${workQueue.length - cursor} candidate(s) left untouched and still open; they will be re-attempted next run.`);
      break;
    }
    if (attempted >= remaining) break; // backfill can grow workQueue past the budget's raw length
    attempted++;
    try {
      // The one path from "we decided to fix this" to "a real branch/PR
      // exists" — shipDraftForRecommendation already runs the full
      // generate -> auto-select -> submit -> approve chain (see its own
      // doc comment above). This used to be followed by an inline
      // re-implementation of that exact same chain on the same
      // recommendation — a merge leftover from when the shared helper was
      // extracted that never had its original call site removed. Effect in
      // production: every safe-tier fix generated, submitted, and approved
      // TWICE (double GitHub writes, double API/model cost), and the
      // second pass's real outcome overwrote the first's — caught by this
      // session's own test suite expecting exactly one generateDraft call
      // per shipped recommendation and observing two.
      const approved = await shipDraftForRecommendation(siteId, {
        generatorId: rec.recommendation_type, params: rec.params,
        findingId: rec.finding_ids[0], source: SOURCE, findingOrigin: rec.detecting_agents?.[0] || null,
        // Unattended cron pass, not a user's click — worth waiting out a
        // same-site design-profile derivation so today's run can ship a real
        // PR instead of only unblocking tomorrow's. See design-drift.js's
        // DESIGN_AGENT_WAIT_MS.
        waitForDesignAgent: true,
        deferPr: true,
        // Lets draftShipState tell a live commit on THIS run's branch from a
        // ghost on a prior day's (see lib/draft-ship-state.js).
        batchBranch: branchName,
      });

      // deferPr means approved.pr_number is never set here (see
      // approveAndPublishDraft's own comment on deferPr) — this item's PR
      // opens once, for the whole batch, in the finalize step after this
      // loop, not per item. Queue it rather than calling openDraftPr now
      // (which would 422: the branch hasn't actually been pushed yet).
      //
      // The circuit breaker/refusal counters below still reset on THIS
      // commit succeeding, same as before deferPr existed — a real commit
      // landing locally is genuine evidence the pipeline is healthy for
      // this item, independent of whether the batch's one shared push
      // later succeeds or fails (that's a systemic outcome affecting every
      // pending item equally, not a signal about any one of them).
      // An already-finished draft (its PR is open, or already merged) must
      // never join `pending`: finalizeBatchPr feeds pending[0] to
      // openDraftPr, which hard-requires 'branch_pushed' and throws 404 for
      // anything else — one finished sibling would fail the whole batch and
      // abandon every genuinely new draft in it. Count it and move on.
      if (approved.alreadyShipped) {
        shipped++;
        recordOutcome(siteId, rec.recommendation_type, 'shipped', { recommendationId: rec.id, draftId: approved.id }).catch(() => {});
        consecutiveSystemicFailures = 0;
        consecutiveRefusals = 0;
        continue;
      }
      pending.push({ rec, draft: approved });
      //
      // shipped++ and recordOutcome('shipped', ...) now happen after this
      // loop, once the batch's PR is actually confirmed open (see the
      // finalize step below) — counting an item as shipped before its PR
      // exists would overstate what landed, same reasoning the old
      // per-item openDraftPr comment here used to describe.
      //
      // Both streaks reset: a success is evidence against a systemic fault AND
      // against "this site has nothing it can honestly ship", so neither
      // counter should carry across it.
      consecutiveSystemicFailures = 0;
      consecutiveRefusals = 0;
    } catch (err) {
      // A RATE LIMIT is neither a fault nor a refusal — it is a statement
      // about timing, and the identical attempt succeeds once the budget
      // refills. Checked before everything else below, and it stops the run
      // rather than continuing: every remaining item shares the one
      // exhausted token, so carrying on can only produce more of the same
      // failure while spending a generation call on each.
      //
      // Critically, this item is NOT counted as failed and NOT abandoned —
      // on 2026-09-01, counting rate limits as ordinary failures is what
      // turned an hour of exhausted quota into 113 permanently abandoned
      // drafts.
      const shipFailure = classifyShipFailure(err, { isRefusal: false });
      if (shipFailure.kind === FAILURE_KIND.RATE_LIMIT) {
        stoppedReason = 'github-rate-limited';
        console.warn(`[auto-remediation] ${clientLabel}: GitHub rate limit hit on recommendation ${rec.id} (${rec.recommendation_type}) — stopping this run. ${workQueue.length - cursor - 1} candidate(s) left untouched; this item and they stay open and will be re-attempted next run. Not a fault.`);
        break;
      }
      failed++;
      // A REFUSAL is not a fault, and must not feed the systemic breaker.
      //
      // Generators deliberately throw { status: 4xx, userFacing: true } when a
      // specific item cannot be drafted honestly — "Review schema had no real
      // data on the page", "external citations require real search grounding".
      // That is the no-fabrication policy working, and it says nothing about
      // whether the system is healthy.
      //
      // Two ways to be a refusal, in priority order. The explicit `refusal`
      // flag is the one a thrower should set, because it says what it means;
      // the 4xx heuristic stays as the compatibility path for the many
      // generators that only set { status, userFacing }. The flag is checked
      // first so a refusal can carry a 5xx status where that is the honest
      // HTTP answer — the Quality Gate's exhaustion is a 502 because the
      // generator is upstream of us, but it is still a statement about one
      // item's content, not about system health.
      const isRefusal = err?.refusal === true
        || (err?.userFacing === true && err?.status >= 400 && err?.status < 500);
      if (isRefusal) {
        refused++;
        consecutiveSystemicFailures = 0;
        consecutiveRefusals++;
        // 'refused' is logged too, but scored as neither success nor
        // failure — see generator-learning.js's POSITIVE/NEGATIVE sets. It
        // still exists in the log so a reader can see the full picture, a
        // refusal just never moves the learned score either direction.
        //
        // detail carries err.reason (a short, stable code like
        // 'invalid-edit' — see implementers' {ok:false, reason, error}
        // contract) rather than the full message: this is what lets
        // code-self-repair.js's escalation sweep group repeats of the SAME
        // underlying problem across days/sites, the same way the 'failed'
        // branch below already does with err.message. Previously this was
        // the one gap — a refusal's reason was never persisted at all.
        recordOutcome(siteId, rec.recommendation_type, 'refused', { recommendationId: rec.id, detail: err?.reason || null }).catch(() => {});
        maybeEscalateToCodeRepair({ generatorId: rec.recommendation_type, reason: err?.reason || null, errorMessage: err.message, siteId }).catch((escErr) => {
          console.error(`[auto-remediation] code self-repair escalation check failed for ${rec.recommendation_type}:`, escErr.message);
        });
        // err.stale === true means the generator itself found live evidence
        // the recommendation's premise is no longer true (e.g. schema.js
        // discovering the page already has real schema of the recommended
        // type) — not "can't fix this", but "there's nothing left to fix".
        // Left merely 'refused', the row stays open and gets re-attempted
        // (and re-refused) by every future run forever — confirmed live on
        // site 1, where the same handful of schema recommendations have
        // refused on repeat since Aug 14, eating into the refusal-streak
        // breaker every day without ever converging. Close it the same way
        // closeStaleRecommendations does (status='superseded'), since this is
        // exactly what that sweep would eventually conclude too, just
        // discovered here first and directly instead of on its next pass.
        if (err?.stale === true) {
          closeRecommendation(rec.id).catch(() => {});
        }
      } else {
        consecutiveRefusals = 0;
        // detail is err.message, which every generator on this path is
        // already required to keep customer-safe (UserFacingError/
        // safeMessage) — no raw provider text reaches this log.
        recordOutcome(siteId, rec.recommendation_type, 'failed', { recommendationId: rec.id, detail: String(err.message || '').slice(0, 500) }).catch(() => {});
        maybeEscalateToCodeRepair({ generatorId: rec.recommendation_type, reason: String(err.message || '').slice(0, 500), errorMessage: err.message, siteId }).catch((escErr) => {
          console.error(`[auto-remediation] code self-repair escalation check failed for ${rec.recommendation_type}:`, escErr.message);
        });

        if (shipFailure.kind === FAILURE_KIND.SYSTEMIC) {
          consecutiveSystemicFailures++;
          console.error(`[auto-remediation] ${clientLabel}: SYSTEMIC failure on recommendation ${rec.id} (${rec.recommendation_type}) — ${shipFailure.reason} (${consecutiveSystemicFailures}/${SYSTEMIC_FAILURE_LIMIT} consecutive).`);
        } else {
          // An INDIVIDUAL item failure never touches the systemic streak —
          // a bad locations.js entry says nothing about GitHub or the
          // database, and must not count toward the breaker that exists for
          // those. Instead it feeds this generator's OWN family tally: two
          // failures sharing a normalized shape quarantine the generator for
          // the rest of this run (not the finding — that's the separate,
          // cross-run convergence cap in ship-pacing.js) and free its slot
          // for backfill, so ~15 locations.js items sorting together cost
          // this run at most 2 attempts, not the whole remaining budget.
          consecutiveSystemicFailures = 0;
          const familyKey = failureFamilyKey(rec.recommendation_type, err);
          const count = (familyFailureCounts.get(familyKey) || 0) + 1;
          familyFailureCounts.set(familyKey, count);
          if (count >= FAMILY_FAILURE_LIMIT && !quarantinedGenerators.has(rec.recommendation_type)) {
            quarantinedGenerators.set(rec.recommendation_type, familyKey);
            const note = `${rec.recommendation_type}: quarantined for the rest of this run after ${count} failures matching "${familyKey}" — other generators keep using the remaining budget; retried next run.`;
            quarantineNotes.push(note);
            console.warn(`[auto-remediation] ${clientLabel}: ${note}`);
          }
        }
      }
      console.warn(`[auto-remediation] ${clientLabel} ${isRefusal ? 'declined to draft' : 'could not auto-fix'} recommendation ${rec.id} (${rec.recommendation_type}), leaving it open:`, err.message);
    }
  }

  // SHARED QUEUE DRAIN, continued: fold whatever real headroom is left after
  // the ordinary analytics/analyst loop above into THIS SAME batch. Headroom
  // is computed here, not before the loop, because backfill can consume
  // budget unpredictably up to `remaining` — only after the loop finishes is
  // "how much is actually left today" a real number.
  let queueHeadroom = Math.max(0, remaining - attempted);

  // learned-repair: a queued INTENT, not yet generated. This run doubles as
  // both preparation and shipping for this lane (see learned-repair.js's own
  // module comment) — generation happens right here, through the exact same
  // shipDraftForRecommendation pipeline every ordinary item in this run
  // already used, so a borrowed repair gets the same Quality Gate,
  // design-verification and failure handling as anything else.
  for (const item of learnedRepairQueueItems) {
    if (queueHeadroom <= 0) break;
    queueHeadroom--;
    attempted++;
    try {
      const approved = await shipDraftForRecommendation(siteId, {
        generatorId: item.generator_id, params: item.params, findingId: item.finding_id,
        source: SOURCE, findingOrigin: 'learned-repair', memoryRefId: item.memory_ref_id,
        waitForDesignAgent: true, deferPr: true, batchBranch: branchName,
      });
      if (approved.alreadyShipped) {
        // A prior run's commit for this same finding already reached
        // 'branch_pushed'/beyond — nothing new to ship, but the queue row
        // must still leave 'queued' or it would sit there forever.
        await markQueueItemShipped(item.id).catch(() => {});
        continue;
      }
      pending.push({
        rec: { id: null, recommendation_type: item.generator_id, finding_ids: [item.finding_id] },
        draft: approved,
        learnedRepairQueueId: item.id,
        memoryRefId: item.memory_ref_id,
      });
    } catch (err) {
      failed++;
      console.warn(`[auto-remediation] ${clientLabel}: learned-repair queue item ${item.id} (${item.generator_id}) could not be prepared, leaving it for the Action Center:`, err.message);
      // ITEM-STATE refusals say nothing about whether the borrowed repair
      // itself is portable — see learned-repair.js's identical prior
      // reasoning, preserved here since this is now where that ship attempt
      // actually happens.
      const isItemStateRefusal = err.reason === 'awaiting-human-review' || err.reason === 'draft-reset';
      await releaseQueueItem(item.id, { retryable: isItemStateRefusal, error: String(err.message || '').slice(0, 500) }).catch(() => {});
      if (!isItemStateRefusal) {
        await recordFixOutcome({
          memoryRefId: item.memory_ref_id, outcome: 'failure', agentId: 'learned-repair',
          generatorId: item.generator_id, siteId,
          notes: `cross-client repair failed: ${sanitizeForCustomer(err.message, '(internal error — see server logs)')}`,
        }).catch(() => {});
      }
    }
  }

  // FILE-EDITS lanes (content-repair, template-capability-repair): edits
  // already computed and validated by their own producer — nothing left to
  // generate, only to push onto the same batch commit chain. Not gated by
  // queueHeadroom in the same per-slot sense as generator-produced work (both
  // are small, fixed-volume correctness/unblocking repairs — see their own
  // high fixed `score` at enqueue time) but still count toward
  // `attempted`/the shared ceiling like every other autonomous item, so a
  // pathological day can't use them to bypass the 100-item hard stop.
  // Whether the batch branch already has a real ref on GitHub. pushDraftBranch
  // creates it for real (not deferred — only the FINAL ref move at
  // endBatchPush is deferred) the first time `exists` is false; every push
  // after that first one, in this run, MUST pass exists:true or it tries to
  // re-create an already-existing branch. `pending.length > 0` here already
  // reflects every earlier real push this run (the ordinary analytics/
  // analyst loop and the learned-repair drain above), so it is the correct
  // starting value.
  let branchExistsOnGithub = pending.length > 0;
  for (const item of fileEditsQueueItems) {
    if (queueHeadroom <= 0) break;
    queueHeadroom--;
    attempted++;
    try {
      const files = (item.params?.edits || []).map(({ path, content }) => ({ path, content }));
      const pushed = await pushDraftBranch(
        site,
        { id: `${item.source}-${item.id}`, action_type: item.source },
        files,
        { branchName, exists: branchExistsOnGithub },
      );
      if (!pushed.ok) throw new Error(pushed.error || `${item.source} push failed`);
      branchExistsOnGithub = true;
      shippedFileEditsQueueIds.push(item.id);
    } catch (err) {
      failed++;
      console.warn(`[auto-remediation] ${clientLabel}: ${item.source} queue item ${item.id} could not be pushed onto the batch, leaving it for the next run:`, err.message);
      await releaseQueueItem(item.id, { retryable: true, error: String(err.message || '').slice(0, 500) }).catch(() => {});
    }
  }

  // One real push + one PR open for the whole run (see beginBatchPush
  // above), instead of one of each per item. Every `pending` item's commit
  // already landed locally; this either confirms all of them together as
  // genuinely shipped, or — on failure — reverts every one of them so
  // nothing is silently counted as shipped work that never reached GitHub.
  // Called unconditionally whenever batching was begun (see `batching`
  // above), not just when `pending.length > 0` — finalizeBatchPr's own
  // endBatchPush call is what clears beginBatchPush's state, and skipping
  // it on a fully-failed/fully-refused run would leave that state stuck.
  if (batching) {
    const finalization = await finalizeBatchPr(site, branchName, pending.map((p) => p.draft.id));
    if (!finalization.ok) {
      // A TRANSIENT batch failure must not be terminal. This one call fails
      // the whole batch at once by design — one shared push, one shared PR —
      // so whatever it decides is applied to every pending item together.
      // Abandoning unconditionally is what made 2026-09-01's one-hour PAT
      // exhaustion cost 54 drafts in a single call: each had a real,
      // Quality-Gate-passed commit already built, and every one was thrown
      // away for a failure that would have succeeded on the next pass.
      //
      // recordMergeFailure is the existing retryable-in-place idiom for
      // exactly this shape (store/drafts.js) — it records the error WITHOUT
      // changing status, and an unresolved apply_error already excludes a
      // draft from getDraftedFindingIds, so the underlying finding reopens
      // for Recommendations and the next run re-attempts it. Nothing is
      // counted as shipped that wasn't: these drafts' commits never reached
      // GitHub (the batch overlay holds them locally until the push that
      // just failed), and they stay visibly unshipped either way.
      const transient = finalization.rateLimited === true;
      if (pending.length > 0) {
        const disposition = transient
          ? `${pending.length} item(s) left re-attemptable for the next run`
          : `${pending.length} item(s) reverted to failed`;
        console.error(`[auto-remediation] ${clientLabel}: batch push/PR failed for ${branchName}: ${finalization.error} — ${disposition}.`);
      }
      if (transient) stoppedReason = 'github-rate-limited';
      await Promise.all(pending.map(async ({ rec, draft, learnedRepairQueueId, memoryRefId }) => {
        // A transient failure is not scored against the generator either:
        // generator-learning.js reads these outcomes to decide what to trust,
        // and a rate limit says nothing about whether this generator's output
        // was any good.
        if (!transient) {
          failed++;
          recordOutcome(siteId, rec.recommendation_type, 'failed', { recommendationId: rec.id, detail: finalization.error }).catch(() => {});
        }
        const record = transient
          ? recordMergeFailure(siteId, draft.id, finalization.error)
          : markDraftAbandoned(siteId, draft.id, `Batch push/PR failed: ${finalization.error}`, null);
        await record.catch((recordErr) => {
          console.error(`[auto-remediation] could not ${transient ? 'mark retryable' : 'abandon'} draft ${draft.id} after batch push/PR failure:`, recordErr.message);
        });
        if (learnedRepairQueueId) {
          await releaseQueueItem(learnedRepairQueueId, { retryable: transient, error: finalization.error }).catch(() => {});
          if (!transient) {
            recordFixOutcome({
              memoryRefId, outcome: 'failure', agentId: 'learned-repair', generatorId: rec.recommendation_type, siteId,
              notes: `batch push/PR failed: ${sanitizeForCustomer(finalization.error, '(internal error — see server logs)')}`,
            }).catch(() => {});
          }
        }
      }));
      if (shippedFileEditsQueueIds.length) {
        await Promise.all(shippedFileEditsQueueIds.map((id) => releaseQueueItem(id, { retryable: transient, error: finalization.error }).catch(() => {})));
      }
    } else if (pending.length > 0 || shippedFileEditsQueueIds.length > 0) {
      prUrl = finalization.prUrl;
      for (const { rec, draft, learnedRepairQueueId, memoryRefId } of pending) {
        shipped++;
        // Phase 5: best-effort, never awaited into the failure path — a
        // logging problem must not turn a real shipped fix into a reported
        // failure. recordOutcome already swallows its own errors internally.
        recordOutcome(siteId, rec.recommendation_type, 'shipped', { recommendationId: rec.id, draftId: draft.id }).catch(() => {});
        if (learnedRepairQueueId) {
          markQueueItemShipped(learnedRepairQueueId).catch(() => {});
          recordFixOutcome({ memoryRefId, outcome: 'success', agentId: 'learned-repair', generatorId: rec.recommendation_type, siteId }).catch(() => {});
        }
      }
      for (const id of shippedFileEditsQueueIds) {
        shipped++;
        markQueueItemShipped(id).catch(() => {});
      }
      console.log(`[auto-remediation] ${clientLabel}: batch pushed and PR opened: ${finalization.prUrl} (${finalization.pushed} commit(s), ${pending.length} recommendation(s), ${shippedFileEditsQueueIds.length} file-edits item(s)).`);
    }
  }

  if (quarantineNotes.length) {
    console.log(`[auto-remediation] ${clientLabel}: ${quarantineNotes.length} generator(s) quarantined this run: ${[...quarantinedGenerators.keys()].join(', ')}.`);
  }
  console.log(
    `[auto-remediation] ${clientLabel}: run complete — attempted ${attempted}, shipped ${shipped}, failed ${failed}, `
    + `refused ${refused}, quarantined ${quarantined}${stoppedReason ? `, stopped: ${stoppedReason}` : ''}.`
  );

  return finish({
    attempted, shipped, failed, refused, quarantined,
    skipped: candidates.length - attempted,
    spentToday, dailyLimit, stoppedReason, prUrl,
    // Full selection reasoning — eligible/selected/skipped counts, per-tier
    // and per-generator distribution, the top-ranked items with their score
    // factors, and why each deferred item lost. Persisted on the run row
    // (auto_remediation_runs.selection, migration 137) so "why was X
    // selected instead of Y" is answerable after the fact, not only from a
    // console log that scrolled away.
    selection: {
      ...selection,
      quarantinedGenerators: Object.fromEntries(quarantinedGenerators),
      quarantineNotes,
    },
  });
}

// The one path from "we decided to fix this" to "a real branch exists",
// extracted verbatim from the loop above rather than reimplemented.
//
// It is shared with agents/lib/learned-repair.js's cross-client interception
// deliberately: that path acts on evidence borrowed from another client, so
// it is the LAST thing that should get its own subtly-different copy of the
// draft -> submit -> approve -> push chain. One path means one set of gates
// (Quality Gate and its bounded regeneration inside generateDraft, then the
// rendering gate, second Quality Gate, implementer preview and exact-match
// refusal inside approveAndPublishDraft), and no way for a future change to
// harden one caller and miss the other.
//
// `memoryRefId` binds the specific agent_fix_memory row being reused onto the
// draft, so fix-verification.js's later live re-check feeds success or
// failure back to THAT row rather than to "some fix for this generator".
// Null for the ordinary same-site path, which lets generateDraft do its own
// lookup exactly as before.
//
// Throws on any failure — callers decide what a failure means (auto-
// remediation leaves the recommendation open; the learned-repair path also
// records a failed reuse against the memory it borrowed).
export async function shipDraftForRecommendation(siteId, { generatorId, params, findingId, source, findingOrigin = null, memoryRefId = null, waitForDesignAgent = false, deferPr = false, batchBranch = null }) {
  const draft = await generateDraft(siteId, { generatorId, params, source, findingOrigin, findingId, memoryRefId, waitForDesignAgent });

  const autoSelected = autoSelectMetaTitle(generatorId, draft.content);
  if (autoSelected) {
    const updated = await updateDraft(siteId, draft.id, { content: autoSelected });
    if (updated) draft.content = updated.content;
  }

  const submitted = await submitDraftForApproval(siteId, draft.id);
  if (!submitted) {
    // generateDraft is idempotent per finding (see its own comment): it
    // returns the EXISTING draft rather than billing a second LLM call. That
    // draft can legitimately be past 'draft'/'edited', and
    // submitDraftForApproval only moves those two — so it returns null and
    // this used to throw a generic failure.
    //
    // That failure was structural, not incidental. recordApplyFailure
    // deliberately leaves a draft at 'approved' with an apply_error so the
    // "Push Branch" button stays retryable, and getDraftedFindingIds
    // deliberately treats an unresolved apply_error as "not handled" so the
    // finding reopens. Together those two correct behaviors mean the
    // unattended loop re-picks the finding every run, gets the same stuck
    // draft back, fails to submit it, and reports a FAILURE that feeds this
    // generator's family-quarantine tally (failure-policy.js) — a repeat of
    // the same stuck-draft shape quarantines expand-content for the rest of
    // the run. Live on site 1: 8 expand-content drafts stuck at 'approved' since
    // 2026-08-28, 19 recorded failures, and a retry path that could never
    // converge because nothing ever re-ran apply().
    //
    // So resume from where the draft actually IS instead of insisting it
    // start over. This is the same recovery the UI already offers by hand,
    // reusing that exact function rather than a second implementation.
    const current = await getDraft(siteId, draft.id);
    // A 'branch_pushed' draft's commit is live either on the given batch
    // branch, OR — when this call isn't batched at all (deferPr false, e.g.
    // learned-repair.js's single-item ship, never wrapped in a beginBatchPush)
    // — on the draft's OWN branch, since a non-batched apply() moves the real
    // ref directly with no overlay involved. Without this, every non-batched
    // caller passed no batchBranch, currentBatchBranch was always null, and a
    // draft that had genuinely pushed (only the PR-open step remaining) was
    // misclassified STRANDED and abandoned — discarding real, already-shipped
    // work and forcing a full, costly regeneration.
    const liveBranch = deferPr ? batchBranch : current?.branch_name;
    const state = draftShipState(current, { currentBatchBranch: liveBranch });
    if (state === SHIP_STATE.RESUME_APPLY) {
      // Re-run apply() — the step that actually failed. The content is
      // already generated, Quality-Gated and approved; regenerating it would
      // spend another model call to arrive at the same draft.
      return await pushDraftBranch(siteId, draft.id);
    }
    if (state === SHIP_STATE.AWAITING_PR) {
      if (!deferPr) {
        // Non-batched (learned-repair.js's single-item ship): no batch
        // finalize step is ever coming for this call, so open the PR
        // directly rather than returning a branch_pushed draft with no PR
        // and no caller left to open one — the same permanently-PR-less
        // outcome fixed in routes/action-center.js's shipRecommendation,
        // for this codepath's own non-batched caller.
        return await openDraftPr(siteId, draft.id);
      }
      // Batched: a real commit on THIS run's branch, still needing the
      // shared PR the caller opens once for the whole batch. Safe to queue.
      return current;
    }
    if (state === SHIP_STATE.SHIPPED) {
      // Already merged or already has its PR. It must NOT join the batch's
      // pending list: finalizeBatchPr feeds pending[0] to openDraftPr, which
      // hard-requires 'branch_pushed' and throws 404 otherwise — one finished
      // sibling would fail the whole batch and abandon every genuinely new
      // draft in it. Flagged so the caller counts it and moves on.
      return { ...current, alreadyShipped: true };
    }
    if (state === SHIP_STATE.HUMAN_OWNED) {
      // Someone is reviewing this right now. Leave it exactly as it is — no
      // ship, and emphatically no abandon.
      const err = new Error(`Draft #${draft.id} is awaiting human review ("${current.status}") — left untouched.`);
      err.refusal = true;
      err.reason = 'awaiting-human-review';
      throw err;
    }
    // STRANDED: a genuinely stuck row, and the repo's own recorded lesson for
    // this code applies — never leave a partially-failed draft sitting in a
    // non-terminal status. Abandon it so the next run generates a clean one,
    // and report a REFUSAL rather than a failure: this is one item's state
    // problem, not evidence the pipeline is broken, and must not trip the
    // circuit breaker.
    await markDraftAbandoned(siteId, draft.id, `Stuck at "${current?.status || 'unknown'}" and not resumable — abandoned so a fresh draft can be generated.`, null)
      .catch((err) => console.error(`[auto-remediation] could not abandon unresumable draft ${draft.id}:`, err.message));
    const err = new Error(`Draft was stuck at "${current?.status || 'unknown'}" and has been reset for a fresh attempt.`);
    err.refusal = true;
    err.reason = 'draft-reset';
    throw err;
  }

  let approved = await approveAndPublishDraftUnattended(siteId, draft.id, { userId: null, deferPr });

  // A credential failure gets exactly ONE immediate in-run retry before it is
  // allowed to become a real outcome.
  //
  // Why, given credentials don't normally fluctuate: on 2026-09-07 a single
  // ship attempt failed with "GitHub App is not configured" while two sibling
  // items in the SAME process, seconds apart, authenticated fine — and the
  // credential resolved cleanly on every subsequent check. No code path
  // explains that (index.js loads dotenv before any other import, nothing
  // outside tests ever mutates these vars, and appConfigured() is a pure
  // synchronous env read), so there is no root cause to fix here. What CAN be
  // fixed is the consequence: without this, one unexplained blip abandons a
  // draft and parks the recommendation at NEEDS_HUMAN — deliberately not
  // auto-retryable, since a genuinely absent credential must not be retried
  // forever — meaning a human has to notice and requeue it by hand.
  //
  // One retry costs one API call and settles it either way: it succeeds (the
  // blip was real and transient, and the item ships normally), or it fails
  // identically (the credential is genuinely missing, and the existing
  // NEEDS_HUMAN classification is correct and now better evidenced).
  if (!approved.branch_name && CREDENTIAL_FAILURE_PATTERN.test(approved.apply_error || '')) {
    console.warn(`[auto-remediation] ${clientLabel} draft ${draft.id}: credential resolution failed ("${approved.apply_error}") — retrying once before treating it as a real outcome.`);
    await new Promise((r) => setTimeout(r, CREDENTIAL_RETRY_DELAY_MS));
    approved = await approveAndPublishDraftUnattended(siteId, draft.id, { userId: null, deferPr });
    if (approved.branch_name) {
      console.warn(`[auto-remediation] ${clientLabel} draft ${draft.id}: credential retry SUCCEEDED — the first failure was transient, not a real configuration gap.`);
    }
  }

  if (!approved.branch_name) {
    const message = approved.apply_error || 'Approved but no branch was pushed';
    const err = new Error(message);
    // implementer.apply()'s {ok:false, reason, error} (types.js) never
    // survives past this point — approveAndPublishDraftUnattended's !ok
    // path (action-center.js) only persists the message to drafts.apply_error,
    // then re-fetches the draft from the DB before returning, so `reason` is
    // gone by the time it gets here. Recognized by message shape instead
    // (same compatibility-path reasoning as the 4xx heuristic below) rather
    // than plumbing a new column through for it.
    //
    // Both patterns below are known-recurring, non-systemic, per-ITEM
    // conditions — not evidence of the "revoked token / moved branch" class
    // of systemic fault the SYSTEMIC breaker (failure-policy.js) exists to
    // catch — so marked as refusals here rather than left to become ordinary
    // failures. Confirmed live on site 1: 2 schema-repair items and 3
    // analytics-install/qa-content items failed identically on every run
    // since Aug 25-26, each time contributing to (and some days tripping)
    // the old all-purpose circuit breaker and halting the rest of that day's
    // budgeted work.
    if (/anchor\(s\) no longer found verbatim|anchor\(s\) appear more than once/.test(message)) {
      // exact-match-patch.js's describePatchFailure: the page's live source
      // no longer contains the exact text detection captured. That is the
      // same "found live evidence the recommendation's premise is no longer
      // true" signal the err.stale handling below already closes for —
      // reached via implementer.apply() instead of the generator, but the
      // conclusion is identical: re-detection, not eternal retry, is what
      // resolves this.
      err.refusal = true;
      err.stale = true;
      err.reason = 'source-anchor-not-found';
    } else if (message.startsWith(NO_FILE_MAPPING_FRAGMENT) || message.startsWith(NO_MARKERS_CONFIGURED_FRAGMENT)) {
      // url-file-map.js's 'no-file-mapping'/'no-insertion-marker': a page or
      // marker this site's operator hasn't onboarded yet (see
      // action-center-onboarding skill). Real and worth surfacing — left
      // open, NOT closed as stale — but it is a known per-item config gap,
      // not a systemic fault, so it must not trip the breaker either.
      err.refusal = true;
      err.reason = 'no-file-mapping';
    } else if (message.includes(UNVERIFIED_PLACEHOLDER_FRAGMENT)) {
      // marker-merge.js / data-array-content.js: the generator could not
      // confirm a real value for a field (analytics-install's trackingId is
      // the recurring case — trust-compliance.js deliberately files that
      // finding even with no stored ID, so a human can generate the draft
      // and edit the placeholder by hand). This recurs identically on every
      // unattended attempt until a human does that, exactly the same
      // per-item, non-systemic shape as the two patterns above — it must
      // not trip the breaker either.
      err.refusal = true;
      err.reason = 'unverified-placeholder-field';
    } else if (/uses classes this site only ever uses for its/.test(message)) {
      // design-drift.js's checkDesignIntegrityGate: THIS recommendation's
      // styled markup failed automated role verification (a confirmed
      // role-mismatch — the zunkireelabs.com incident class). Exactly the
      // per-item, non-systemic case the two patterns above already close
      // for, and critically must be handled the same way here: since the
      // check runs against the site's one shared profile, a real defect in
      // that profile would otherwise fail several consecutive
      // recommendations identically and, left as an ordinary failure, would
      // both quarantine this generator needlessly and risk tripping the
      // systemic breaker — recreating the exact whole-site blocking behavior
      // removing the human sign-off gate was meant to end.
      err.refusal = true;
      err.reason = 'design-integrity-failed';
    }
    throw err;
  }
  return approved;
}
