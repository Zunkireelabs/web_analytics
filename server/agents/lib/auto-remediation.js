import { listOpenRecommendations, closeRecommendation } from '../../store/recommendations.js';
import { getDraftedFindingIds, getPendingDraftFilePaths, submitDraftForApproval, updateDraft, countDraftsBySourceToday, hasRecentDraftOfType, markDraftAbandoned, recordMergeFailure } from '../../store/drafts.js';
import { getSiteById } from '../../store/read.js';
import { resolveFile } from '../../implementers/lib/url-file-map.js';
import { generateDraft, approveAndPublishDraftUnattended, autoSelectMetaTitle, finalizeBatchPr } from '../../routes/action-center.js';
import { batchBranchName, beginBatchPush } from '../../implementers/lib/github-ops.js';
import { classifyRecommendation, AUTONOMY_DECISION } from './autonomy-decision.js';
import { classify as classifyForActionCenterCategory } from './recommendation-taxonomy.js';
import { getLearnedConfidenceMap, recordOutcome } from './generator-learning.js';
import { maybeEscalateToCodeRepair } from './code-self-repair.js';
import { isOnboardingAnalysisPending } from '../../implementers/lib/onboarding-readiness.js';
import { getLastKnownRateLimit, RATE_LIMIT_RESERVE } from '../../github/client.js';
import { classifyFailure } from '../../lib/failure-classification.js';

const SOURCE = 'auto-remediation';

// How many consecutive failures trip the breaker for the rest of this site's
// run. Consecutive rather than cumulative on purpose: an occasional failure
// mixed in with successes is normal (one bad page among many), whereas five
// in a row is the signature of something systemic — a revoked GitHub token, a
// url_file_map that stopped resolving, a repo whose default branch moved.
// Without this, one such fault burns the entire daily budget on 60 identical
// failures and buries the real cause in noise.
//
// Raised from 3 to 5 (2026-08-30): known non-systemic, per-item failures
// (see isRefusal below — a stale exact-match anchor, or a genuinely missing
// per-page url_file_map/marker entry) are now classified as refusals rather
// than failures and no longer feed this counter at all, so 3 was only ever
// being tripped by real config gaps, not by a systemic fault. 5 keeps a
// slightly wider margin against the failure modes this breaker actually
// exists for, now that those two known-recurring items are already
// diverted to isRefusal.
const CONSECUTIVE_FAILURE_LIMIT = 5;

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

// Generators that publish net-new content on a cadence rather than fixing an
// existing page, and so are paced instead of merely budgeted. The daily
// budget answers "how much work per day"; this answers "how often does this
// KIND of work happen at all" — a distinction the budget alone can't make,
// since 28 open blog-outline recommendations are 28 legitimate candidates as
// far as it is concerned.
//
// Two rules per entry, both needed:
//   - at most ONE per run, so a single day can't publish a burst; and
//   - none at all if one was published inside the site's gap window.
// The first without the second would still allow one blog every single day.
//
// Paced items are NOT given a separate allowance — the one that survives
// competes for the same auto_remediation_daily_limit slot as every ordinary
// fix, which is what keeps "30 a day" a single honest number.
const PACED_GENERATORS = [
  { generatorId: 'blog-outline', gapColumn: 'blog_min_gap_days', defaultGapDays: 3 },
];

// Drops paced candidates that this site isn't due for yet, and thins the rest
// to one each. Returns the candidates in their original priority order, plus
// the human-readable notes the caller logs — deferrals are never silent, the
// same rule the daily budget's truncation already follows.
export async function applyPacing(site, candidates, { recentDraftCheck = hasRecentDraftOfType } = {}) {
  const timezone = site.timezone || 'UTC';
  const notes = [];
  const dropped = new Set();

  for (const { generatorId, gapColumn, defaultGapDays } of PACED_GENERATORS) {
    const matching = candidates.filter((r) => r.recommendation_type === generatorId);
    if (matching.length === 0) continue;

    const gapDays = site[gapColumn] ?? defaultGapDays;
    if (await recentDraftCheck(site.id, generatorId, gapDays, timezone)) {
      for (const r of matching) dropped.add(r.id);
      notes.push(`${generatorId}: ${matching.length} candidate(s) held — one was published within the last ${gapDays} day(s) (${gapColumn}=${gapDays}).`);
      continue;
    }
    // Due: keep the highest-priority one (candidates arrive in
    // listOpenRecommendations' order), defer the rest to future runs.
    for (const r of matching.slice(1)) dropped.add(r.id);
    if (matching.length > 1) {
      notes.push(`${generatorId}: taking 1 of ${matching.length} open candidate(s); the rest wait for the next ${gapDays}-day slot.`);
    }
  }

  return { paced: candidates.filter((r) => !dropped.has(r.id)), notes };
}

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
//   2. Circuit breaker — CONSECUTIVE_FAILURE_LIMIT below.
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
export async function autoRemediateSafeRecommendations(siteId, {
  globalRemaining = Infinity,
  onboardingAnalysisPending = isOnboardingAnalysisPending,
} = {}) {
  const site = await getSiteById(siteId);
  if (!site?.auto_remediation_enabled) return { attempted: 0, shipped: 0, failed: 0, skipped: 0, stoppedReason: 'disabled' };

  // Two-stage onboarding: a genuinely new tenant's repo connection queues
  // ONLY the whole-site analysis job (job.js's queueDesignAgentDerivationForSite)
  // — this loop must not open a single PR until that analysis has reached a
  // terminal state, however many cron passes that takes. See
  // isOnboardingAnalysisPending's own comment for exactly what "pending"
  // means and why a site that predates this gate is never newly blocked.
  if (await onboardingAnalysisPending(site)) {
    return { attempted: 0, shipped: 0, failed: 0, skipped: 0, stoppedReason: 'onboarding-analysis-pending' };
  }

  const [rows, draftedFindingIds, pendingDraftFilePaths, spentToday, learnedMap] = await Promise.all([
    listOpenRecommendations(siteId),
    getDraftedFindingIds(siteId),
    getPendingDraftFilePaths(siteId),
    countDraftsBySourceToday(siteId, SOURCE, site.timezone || 'UTC'),
    // Phase 5: real outcome history for this site, read once per run. A
    // generator whose recent real attempts have repeatedly failed or been
    // rejected is excluded here — not just reported differently elsewhere —
    // which is what makes learning actually change behavior rather than
    // only change what gets displayed.
    getLearnedConfidenceMap(siteId).catch(() => new Map()),
  ]);
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
  // can't consume budget slots it isn't due for. Only the unattended path
  // paces itself — routes/action-center.js's executeSafeFixes is a human
  // deliberately asking for a batch, and a human doesn't need the agent's
  // sense of rhythm imposed on them.
  const { paced: candidates, notes: pacingNotes } = await applyPacing(site, eligible);
  for (const note of pacingNotes) console.log(`[auto-remediation] site ${siteId}: ${note}`);

  // Daily budget. `remaining` can go negative if the limit was lowered
  // mid-day after work was already done — Math.max keeps that a clean "no
  // budget left" rather than a negative slice that would silently take
  // everything. Also capped by the platform-wide ceiling (globalRemaining),
  // when the caller supplied one — whichever is tighter wins.
  const dailyLimit = site.auto_remediation_daily_limit ?? 60;
  const remaining = Math.max(0, Math.min(dailyLimit - spentToday, globalRemaining));
  if (remaining === 0) {
    const reason = spentToday >= dailyLimit ? 'budget-exhausted' : 'global-ceiling-reached';
    console.log(`[auto-remediation] site ${siteId} has no budget left this run (${spentToday}/${dailyLimit} site budget used${globalRemaining < Infinity ? `, ${globalRemaining} left in the platform-wide ceiling` : ''}) — nothing attempted.`);
    return { attempted: 0, shipped: 0, failed: 0, skipped: candidates.length, spentToday, dailyLimit, stoppedReason: reason };
  }

  // Priority-aware selection (item 7b): listOpenRecommendations already
  // orders by priority tier (high/medium/low) then recency — real, but
  // coarse. Within the SAME tier, prefer higher real expected impact
  // (recommendations.expected_impact.value, the same field health-score.js
  // already reads) weighted by this generator's own learned success
  // confidence (learnedMap, already fetched above) — both real,
  // already-computed numbers, nothing new invented. A generator with no
  // confidence history yet (no learnedMap entry) is treated as neutral
  // (0.5), not penalized relative to a proven-bad one — only a MEASURED low
  // confidence should demote within a tier.
  //
  // Also tempered by learnedMap's SEPARATE impactConfidence (fix-impact.js's
  // measured real-world GSC outcome, see generator-learning.js) — same
  // neutral-0.5 default when there's no history yet, same multiplicative,
  // non-blocking role as `confidence` above. This is the one place measured
  // business impact is allowed to influence action selection: it can only
  // ever scale this generator's rank UP or DOWN within its priority tier,
  // never remove its eligibility or block it outright (a generator with
  // weak measured impact still ships, just later within the same tier) —
  // deliberately not a hard "no impact -> never again" rule (SEO effects
  // are delayed and noisy; see fix-impact.js's own caveat on its delta).
  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  const rankScore = (rec) => {
    const impact = typeof rec.expected_impact?.value === 'number' ? rec.expected_impact.value : 0;
    const learned = learnedMap.get(rec.recommendation_type);
    const confidence = learned?.confidence;
    const impactConfidence = learned?.impactConfidence;
    return impact
      * (typeof confidence === 'number' ? confidence : 0.5)
      * (typeof impactConfidence === 'number' ? impactConfidence : 0.5);
  };
  const ranked = [...candidates].sort((a, b) => {
    const tierDiff = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
    return tierDiff !== 0 ? tierDiff : rankScore(b) - rankScore(a);
  });

  // Category-diverse selection: without this, a category with sheer volume
  // (e.g. 139 GEO Signals) fills the whole day's budget and a category with
  // only 1-3 open items (Blog Opportunities, FAQ Opportunities) never gets a
  // look-in. Take at most PER_CATEGORY_DAILY_CAP items per Action Center
  // category first — still priority-ordered within and across categories
  // since `ranked` already is — then fill any budget left over with the
  // next-highest-priority items regardless of category. A category with
  // fewer than PER_CATEGORY_DAILY_CAP eligible items just contributes what it
  // has; the shortfall is absorbed by the top-up pass rather than left
  // unused. Categories come from the same recommendation-taxonomy.js the
  // Action Center UI itself groups by, so this can't drift from what the
  // dashboard shows as "5 per topic".
  const PER_CATEGORY_DAILY_CAP = 5;
  const perCategoryCount = new Map();
  const picked = [];
  const leftover = [];
  for (const rec of ranked) {
    const { category } = classifyForActionCenterCategory({ source: rec.detecting_agents?.[0], generatorId: rec.recommendation_type });
    const count = perCategoryCount.get(category) || 0;
    if (count < PER_CATEGORY_DAILY_CAP && picked.length < remaining) {
      picked.push(rec);
      perCategoryCount.set(category, count + 1);
    } else {
      leftover.push(rec);
    }
  }
  for (const rec of leftover) {
    if (picked.length >= remaining) break;
    picked.push(rec);
  }
  const budgeted = picked;
  // Never silently truncate: a run that ships 30 of 41 open issues must say
  // so, or the Action Center looks like it simply found fewer problems.
  if (budgeted.length < candidates.length) {
    console.log(`[auto-remediation] site ${siteId}: ${candidates.length} eligible, taking ${budgeted.length} within today's budget (${spentToday}/${dailyLimit} already used); ${candidates.length - budgeted.length} deferred to tomorrow.`);
  }

  let shipped = 0;
  let failed = 0;
  // Refusals are a SUBSET of `failed` — reported separately so a run that
  // declined three items honestly is not read as three things going wrong.
  let refused = 0;
  let consecutiveFailures = 0;
  let consecutiveRefusals = 0;
  let stoppedReason = null;
  let attempted = 0;

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
  const batching = budgeted.length > 0;
  if (batching) beginBatchPush(site, branchName);
  const pending = []; // { rec, draft }

  for (const rec of budgeted) {
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      stoppedReason = 'circuit-breaker';
      console.error(`[auto-remediation] site ${siteId}: ${CONSECUTIVE_FAILURE_LIMIT} consecutive failures — stopping this site's run early to avoid burning the daily budget on a systemic fault. ${budgeted.length - attempted} candidate(s) left untouched and still open.`);
      break;
    }
    if (consecutiveRefusals >= CONSECUTIVE_REFUSAL_LIMIT) {
      stoppedReason = 'refusal-streak';
      console.log(`[auto-remediation] site ${siteId}: ${CONSECUTIVE_REFUSAL_LIMIT} consecutive honest refusals — nothing here can be drafted without fabricating, so stopping rather than spending the rest of the budget proving it. ${budgeted.length - attempted} candidate(s) left untouched and still open. This is not a fault.`);
      break;
    }
    // Stop STARTING new items once GitHub's remaining budget is under the
    // reserve. Deliberately a pre-check rather than only reacting to the
    // first 403: an item that begins near the floor burns a generation call
    // and several writes before failing at the push, so the cheapest place
    // to notice is before the attempt. The items left here stay open and
    // untouched for the next pass — nothing is consumed, so this costs one
    // deferred day at worst, against the whole-run collapse it prevents.
    if (getLastKnownRateLimit().low) {
      stoppedReason = 'github-rate-limited';
      console.warn(`[auto-remediation] site ${siteId}: GitHub API budget under the ${RATE_LIMIT_RESERVE}-request reserve — stopping before starting more work. ${budgeted.length - attempted} candidate(s) left untouched and still open; they will be re-attempted next run.`);
      break;
    }
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
      consecutiveFailures = 0;
      consecutiveRefusals = 0;
    } catch (err) {
      // A RATE LIMIT is neither a fault nor a refusal — it is a statement
      // about timing, and the identical attempt succeeds once the budget
      // refills. Checked before both, and it stops the run rather than
      // continuing: every remaining item shares the one exhausted token, so
      // carrying on can only produce more of the same failure while spending
      // a generation call on each.
      //
      // Critically, this item is NOT counted as failed and NOT abandoned.
      // Counting it would trip CONSECUTIVE_FAILURE_LIMIT after five, which
      // reports a systemic fault ("a revoked token, a moved default branch")
      // for what is really a one-hour wait — and on 2026-09-01 that
      // misreading is what turned an hour of exhausted quota into 113
      // permanently abandoned drafts.
      if (classifyFailure({ stage: 'github_api', err }).errorCode === 'GITHUB_RATE_LIMITED') {
        stoppedReason = 'github-rate-limited';
        console.warn(`[auto-remediation] site ${siteId}: GitHub rate limit hit on recommendation ${rec.id} (${rec.recommendation_type}) — stopping this run. ${budgeted.length - attempted} candidate(s) left untouched; this item and they stay open and will be re-attempted next run. Not a fault.`);
        break;
      }
      failed++;
      // A REFUSAL is not a fault, and must not feed the circuit breaker.
      //
      // Generators deliberately throw { status: 4xx, userFacing: true } when a
      // specific item cannot be drafted honestly — "Review schema had no real
      // data on the page", "external citations require real search grounding".
      // That is the no-fabrication policy working, and it says nothing about
      // whether the system is healthy. The breaker exists for the opposite
      // thing: a revoked token, a moved default branch, a conflicted batch
      // branch — faults where every subsequent attempt is also doomed.
      //
      // Counting refusals broke that distinction badly. Site 1's three
      // permanently-unfixable items sort to positions 1, 2 and 3 (two are
      // high-priority), so tomorrow's run would have refused three times,
      // tripped the breaker, and halted with 0 shipped and 35 shippable
      // candidates untouched — every day, silently, while the machinery was
      // working exactly as designed.
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
        consecutiveFailures = 0;
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
        consecutiveFailures++;
        consecutiveRefusals = 0;
        // detail is err.message, which every generator on this path is
        // already required to keep customer-safe (UserFacingError/
        // safeMessage) — no raw provider text reaches this log.
        recordOutcome(siteId, rec.recommendation_type, 'failed', { recommendationId: rec.id, detail: String(err.message || '').slice(0, 500) }).catch(() => {});
        maybeEscalateToCodeRepair({ generatorId: rec.recommendation_type, reason: String(err.message || '').slice(0, 500), errorMessage: err.message, siteId }).catch((escErr) => {
          console.error(`[auto-remediation] code self-repair escalation check failed for ${rec.recommendation_type}:`, escErr.message);
        });
      }
      console.warn(`[auto-remediation] site ${siteId} ${isRefusal ? 'declined to draft' : 'could not auto-fix'} recommendation ${rec.id} (${rec.recommendation_type}), leaving it open:`, err.message);
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
        console.error(`[auto-remediation] site ${siteId}: batch push/PR failed for ${branchName}: ${finalization.error} — ${disposition}.`);
      }
      if (transient) stoppedReason = 'github-rate-limited';
      await Promise.all(pending.map(async ({ rec, draft }) => {
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
      }));
    } else if (pending.length > 0) {
      for (const { rec, draft } of pending) {
        shipped++;
        // Phase 5: best-effort, never awaited into the failure path — a
        // logging problem must not turn a real shipped fix into a reported
        // failure. recordOutcome already swallows its own errors internally.
        recordOutcome(siteId, rec.recommendation_type, 'shipped', { recommendationId: rec.id, draftId: draft.id }).catch(() => {});
      }
      console.log(`[auto-remediation] site ${siteId}: batch pushed and PR opened: ${finalization.prUrl} (${finalization.pushed} commit(s), ${pending.length} recommendation(s)).`);
    }
  }

  return {
    attempted, shipped, failed, refused,
    skipped: candidates.length - attempted,
    spentToday, dailyLimit, stoppedReason,
  };
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
export async function shipDraftForRecommendation(siteId, { generatorId, params, findingId, source, findingOrigin = null, memoryRefId = null, waitForDesignAgent = false, deferPr = false }) {
  const draft = await generateDraft(siteId, { generatorId, params, source, findingOrigin, findingId, memoryRefId, waitForDesignAgent });

  const autoSelected = autoSelectMetaTitle(generatorId, draft.content);
  if (autoSelected) {
    const updated = await updateDraft(siteId, draft.id, { content: autoSelected });
    if (updated) draft.content = updated.content;
  }

  const submitted = await submitDraftForApproval(siteId, draft.id);
  if (!submitted) throw new Error('Draft was not in a submittable state');

  const approved = await approveAndPublishDraftUnattended(siteId, draft.id, { userId: null, deferPr });
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
    // of systemic fault CONSECUTIVE_FAILURE_LIMIT exists to catch — so they
    // must not feed that counter. Confirmed live on site 1: 2 schema-repair
    // items and 3 analytics-install/qa-content items failed identically on
    // every run since Aug 25-26, each time contributing to (and some days
    // tripping) the circuit breaker and halting the rest of that day's
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
    } else if (/^No url_file_map entry matches|^No markers configured for/.test(message)) {
      // url-file-map.js's 'no-file-mapping'/'no-insertion-marker': a page or
      // marker this site's operator hasn't onboarded yet (see
      // action-center-onboarding skill). Real and worth surfacing — left
      // open, NOT closed as stale — but it is a known per-item config gap,
      // not a systemic fault, so it must not trip the breaker either.
      err.refusal = true;
      err.reason = 'no-file-mapping';
    } else if (/uses classes this site only ever uses for its/.test(message)) {
      // design-drift.js's checkDesignIntegrityGate: THIS recommendation's
      // styled markup failed automated role verification (a confirmed
      // role-mismatch — the zunkireelabs.com incident class). Exactly the
      // per-item, non-systemic case the two patterns above already close
      // for, and critically must be handled the same way here: since the
      // check runs against the site's one shared profile, a real defect in
      // that profile would otherwise fail several consecutive
      // recommendations identically and trip CONSECUTIVE_FAILURE_LIMIT,
      // silently halting every OTHER valid recommendation's shipping for
      // the rest of this run — recreating, via the circuit breaker, the
      // exact whole-site blocking behavior removing the human sign-off gate
      // was meant to end.
      err.refusal = true;
      err.reason = 'design-integrity-failed';
    }
    throw err;
  }
  return approved;
}
