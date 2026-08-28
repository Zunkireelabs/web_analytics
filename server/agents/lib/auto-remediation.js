import { listOpenRecommendations, closeRecommendation } from '../../store/recommendations.js';
import { getDraftedFindingIds, submitDraftForApproval, updateDraft, countDraftsBySourceToday, hasRecentDraftOfType } from '../../store/drafts.js';
import { getSiteById } from '../../store/read.js';
import { generateDraft, approveAndPublishDraftUnattended, autoSelectMetaTitle, openDraftPr } from '../../routes/action-center.js';
import { classifyRecommendation, AUTONOMY_DECISION } from './autonomy-decision.js';
import { classify as classifyForActionCenterCategory } from './recommendation-taxonomy.js';
import { getLearnedConfidenceMap, recordOutcome } from './generator-learning.js';
import { maybeEscalateToCodeRepair } from './code-self-repair.js';
import { isOnboardingAnalysisPending } from '../../implementers/lib/onboarding-readiness.js';

const SOURCE = 'auto-remediation';

// How many consecutive failures trip the breaker for the rest of this site's
// run. Consecutive rather than cumulative on purpose: an occasional failure
// mixed in with successes is normal (one bad page among many), whereas three
// in a row is the signature of something systemic — a revoked GitHub token, a
// url_file_map that stopped resolving, a repo whose default branch moved.
// Without this, one such fault burns the entire daily budget on 30 identical
// failures and buries the real cause in noise.
const CONSECUTIVE_FAILURE_LIMIT = 3;

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
// It ends at an OPEN PULL REQUEST and never merges — see the openDraftPr call
// below for why that boundary is deliberate rather than incidental.
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

  const [rows, draftedFindingIds, spentToday, learnedMap] = await Promise.all([
    listOpenRecommendations(siteId),
    getDraftedFindingIds(siteId),
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
  const eligible = rows.filter((r) => classifyRecommendation(r, learnedMap).decision === AUTONOMY_DECISION.SAFE_TO_AUTO_EXECUTE
    && r.finding_ids.every((fid) => !draftedFindingIds.has(fid)));

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
      });

      // Ensure the chain ends at an OPEN PR, and STOP. This loop deliberately
      // never merges and never calls markDraftImplemented: a human reviewing and
      // merging on GitHub is the intended final gate, and the existing PR-status
      // poller (cron.js's ':20 past the hour' runPrStatusPollForAllSites) flips
      // the draft to 'implemented' once that merge actually happens.
      //
      // Only when approveAndPublishDraft did NOT already open it. That function
      // ends in markDraftPrOpened whenever the implementer exposes mergeToStage,
      // which every real one does — so for the normal path the PR exists before
      // this line is reached. Calling openDraftPr anyway made it throw "Draft
      // not found, or has no pushed branch yet" (it requires status
      // 'branch_pushed', and the draft is already 'pr_opened'), which was caught
      // below and counted the item as FAILED even though its PR was open and
      // correct.
      //
      // That was not a cosmetic miscount. Three consecutive successes tripped
      // the circuit breaker and halted the rest of the day's run — so with the
      // real 30-item budget the loop would have stopped after 3 shipped items
      // every single day, reporting them all as failures. Caught on the first
      // real end-to-end run: draft 698 opened PR #47 and was recorded as a
      // failure.
      //
      // A genuine failure here is still different in kind from one above: the
      // branch is pushed and the work is real, it just isn't proposed yet.
      // Counting that as shipped would overstate what landed, so it stays a
      // failure — and the draft is left at 'branch_pushed', where the manual
      // "Open PR" button can finish it without regenerating anything.
      if (!approved.pr_number) await openDraftPr(siteId, approved.id);


      shipped++;
      // Phase 5: best-effort, never awaited into the failure path — a
      // logging problem must not turn a real shipped fix into a reported
      // failure. recordOutcome already swallows its own errors internally.
      recordOutcome(siteId, rec.recommendation_type, 'shipped', { recommendationId: rec.id, draftId: approved.id }).catch(() => {});
      // Both streaks reset: a success is evidence against a systemic fault AND
      // against "this site has nothing it can honestly ship", so neither
      // counter should carry across it.
      consecutiveFailures = 0;
      consecutiveRefusals = 0;
    } catch (err) {
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
export async function shipDraftForRecommendation(siteId, { generatorId, params, findingId, source, findingOrigin = null, memoryRefId = null, waitForDesignAgent = false }) {
  const draft = await generateDraft(siteId, { generatorId, params, source, findingOrigin, findingId, memoryRefId, waitForDesignAgent });

  const autoSelected = autoSelectMetaTitle(generatorId, draft.content);
  if (autoSelected) {
    const updated = await updateDraft(siteId, draft.id, { content: autoSelected });
    if (updated) draft.content = updated.content;
  }

  const submitted = await submitDraftForApproval(siteId, draft.id);
  if (!submitted) throw new Error('Draft was not in a submittable state');

  const approved = await approveAndPublishDraftUnattended(siteId, draft.id, { userId: null });
  if (!approved.branch_name) throw new Error(approved.apply_error || 'Approved but no branch was pushed');
  return approved;
}
