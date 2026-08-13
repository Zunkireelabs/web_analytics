import { listOpenRecommendations } from '../../store/recommendations.js';
import { getDraftedFindingIds, submitDraftForApproval, updateDraft, countDraftsBySourceToday, hasRecentDraftOfType } from '../../store/drafts.js';
import { getSiteById } from '../../store/read.js';
import { generateDraft, approveAndPublishDraft, autoSelectMetaTitle, openDraftPr } from '../../routes/action-center.js';

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
export async function autoRemediateSafeRecommendations(siteId) {
  const site = await getSiteById(siteId);
  if (!site?.auto_remediation_enabled) return { attempted: 0, shipped: 0, failed: 0, skipped: 0, stoppedReason: 'disabled' };

  const [rows, draftedFindingIds, spentToday] = await Promise.all([
    listOpenRecommendations(siteId),
    getDraftedFindingIds(siteId),
    countDraftsBySourceToday(siteId, SOURCE, site.timezone || 'UTC'),
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
  const eligible = rows.filter((r) => r.risk_tier === 'safe' && !r.blocked_reason
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
  // everything.
  const dailyLimit = site.auto_remediation_daily_limit ?? 30;
  const remaining = Math.max(0, dailyLimit - spentToday);
  if (remaining === 0) {
    console.log(`[auto-remediation] site ${siteId} has already used its full daily budget (${spentToday}/${dailyLimit}) — nothing attempted this run.`);
    return { attempted: 0, shipped: 0, failed: 0, skipped: candidates.length, spentToday, dailyLimit, stoppedReason: 'budget-exhausted' };
  }

  const budgeted = candidates.slice(0, remaining);
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

      await shipDraftForRecommendation(siteId, {
        generatorId: rec.recommendation_type, params: rec.params,
        findingId: rec.finding_ids[0], source: 'auto-remediation',
      });

      const draft = await generateDraft(siteId, {
        generatorId: rec.recommendation_type, params: rec.params, source: SOURCE, findingId: rec.finding_ids[0],
      });

      const autoSelected = autoSelectMetaTitle(rec.recommendation_type, draft.content);
      if (autoSelected) {
        const updated = await updateDraft(siteId, draft.id, { content: autoSelected });
        if (updated) draft.content = updated.content;
      }

      const submitted = await submitDraftForApproval(siteId, draft.id);
      if (!submitted) throw new Error('Draft was not in a submittable state');

      const approved = await approveAndPublishDraft(siteId, draft.id, { userId: null });
      if (!approved.branch_name) throw new Error(approved.apply_error || 'Approved but no branch was pushed');

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
      if (!approved.pr_number) await openDraftPr(siteId, draft.id);


      shipped++;
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
      } else {
        consecutiveFailures++;
        consecutiveRefusals = 0;
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
export async function shipDraftForRecommendation(siteId, { generatorId, params, findingId, source, memoryRefId = null }) {
  const draft = await generateDraft(siteId, { generatorId, params, source, findingId, memoryRefId });

  const autoSelected = autoSelectMetaTitle(generatorId, draft.content);
  if (autoSelected) {
    const updated = await updateDraft(siteId, draft.id, { content: autoSelected });
    if (updated) draft.content = updated.content;
  }

  const submitted = await submitDraftForApproval(siteId, draft.id);
  if (!submitted) throw new Error('Draft was not in a submittable state');

  const approved = await approveAndPublishDraft(siteId, draft.id, { userId: null });
  if (!approved.branch_name) throw new Error(approved.apply_error || 'Approved but no branch was pushed');
  return approved;
}
