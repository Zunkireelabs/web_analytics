// What a failed attempt at a recommendation MEANS for whether to try again.
//
// The knowledge here is not new — it already existed, correct and hard-won,
// as the exclusion list in store/drafts.js's countFailedAttemptsByFinding.
// What it did not have was a name, a return value, or a test: it was a list
// of SQL NOT LIKE clauses that could only ever answer one question ("does
// this attempt count toward the cap?") for one caller, and it answered it by
// matching prose written for humans in a dozen implementer files.
//
// Three things need that same knowledge and can't get it from SQL:
//   - the reconciler, deciding whether a reclaimed draft should come back as
//     retryable work, as a blocked card, or as a closed one;
//   - the Action Center card, telling a user whether the system is going to
//     keep trying or is waiting on them;
//   - the attempt record itself (migration 139), which stores the verdict at
//     the time of the attempt so no future reader re-derives it from prose.
//
// So the list becomes a function. It is still prose matching — the producing
// side is duplicated across server/implementers/ and centralizing THAT is a
// larger refactor (see lib/draft-failure-phrases.js) — but it is now prose
// matching in one place, with a typed result and a test file, instead of
// prose matching inline in a query string where an apostrophe took the whole
// thing down silently on 2026-09-03.
import { FAILURE_CLASS } from './failure-classification.js';
import {
  NO_FILE_MAPPING_FRAGMENT,
  NO_MARKERS_CONFIGURED_FRAGMENT,
  UNVERIFIED_PLACEHOLDER_FRAGMENT,
  DESIGN_NOT_REVIEWED_FRAGMENT,
  LINK_TARGET_UNRESOLVABLE_FRAGMENT,
  LINK_CONFIRMED_ABSENT_FRAGMENT,
  REDIRECT_RULE_NOT_FOUND_FRAGMENT,
  SECTION_REMOVAL_REFUSED_FRAGMENT,
} from './draft-failure-phrases.js';

// What the pipeline should DO. Kept separate from FAILURE_CLASS because
// several distinct classes imply the same action, and the action is the
// thing every consumer actually branches on.
export const RETRY_POLICY = {
  // Transient or infrastructural. The item was never really tried on its
  // merits — try it again, and don't count it against the item.
  RETRY: 'retry',
  // A human must supply something (a url_file_map entry, a marker, a PAT)
  // before any attempt can succeed. Retrying burns spend to reach the
  // identical failure, so the recommendation is BLOCKED with the reason
  // shown, and becomes eligible again the moment the config lands.
  NEEDS_HUMAN: 'needs_human',
  // The failure says the issue is already fixed — usually by another draft
  // that got there first. Not a failure of the item at all; the
  // recommendation should close rather than retry.
  ALREADY_RESOLVED: 'already_resolved',
  // A real, item-specific defect that will recur identically until the item
  // itself changes. This is the ONLY policy that counts toward the
  // convergence cap.
  ITEM_DEFECT: 'item_defect',
  // A human's decision (they closed the PR, the work was replaced). Says
  // nothing about the item. Never auto-counted, never auto-retried on its
  // own — but the recommendation does return to the board so the human can
  // decide again with the attempt history in front of them.
  NEVER: 'never',
};

// The implementers' short, stable reason CODES (the `reason` half of their
// `{ ok: false, reason, error }` contract), as opposed to the human-facing
// prose every other rule in this file matches on.
//
// These reach classifyAbandonReason by a path the prose rules cannot serve:
// auto-remediation.js records a REFUSAL's `err.reason` — the bare code — into
// generator_outcomes.detail, deliberately, so code-self-repair.js can group
// repeats of the same underlying problem. countRefusalsByRecommendation then
// classifies that stored code to decide whether the refusal was the item's
// own fault. A bare code matches none of the prose rules below, so every one
// of them fell through to the ITEM_DEFECT default and counted against the
// item — including the pure config/repo gaps that are definitionally NOT the
// item's fault and that the prose rule at NO_FILE_MAPPING_FRAGMENT already
// classifies correctly when it arrives as a sentence.
//
// Live consequence on site 1 (2026-09-07): the GA4 and Meta Pixel
// analytics-install recommendations sat retired at 12 and 15 "honest
// refusals", every one of them a `no-insertion-marker` — a missing marker
// anchor, which audit-url-file-map.js reports as self-healing at apply time.
// The items were never defective; the refusal cap had simply been counting a
// config gap as the item's own failure since 2026-08-30.
//
// Only codes that say nothing about the ITEM belong here. Anything genuinely
// item-specific is deliberately absent so it still reaches the ITEM_DEFECT
// default and still retires normally — the caps exist for a reason.
const CONFIG_GAP_REASON_CODES = new Set([
  'no-file-mapping',
  'no-insertion-marker',
  'no-markers-configured',
  'render-capabilities-not-configured',
  'render-capability-unknown',
  'not-configured',
  'invalid-config',
  'sanity-config-invalid',
  'no-repo',
  // The mapped sitemap is rebuilt by the site's own build (or is a template): a fact about the site, never about the item.
  'generated-sitemap',
]);

const TRANSIENT_REASON_CODES = new Set([
  'github-error',
  'pr-open-failed',
  'no-branch',
  'batch-branch-conflicted',
  'code-search-error',
  'client-build-check-unavailable',
  'client-build-check-pending',
  'unreachable',
  'homepage-unreachable',
  'no-live-url',
  // Draft LIFECYCLE state, not content. learned-repair.js already carries
  // this exact judgement inline for its own cross-client reuse scoring
  // ("ITEM-STATE refusals ... are plumbing/state noise on the target site,
  // not a defect in the borrowed pattern") — it just had no way to share it
  // with the refusal cap, so the same attempt counted as a defect here while
  // being correctly excused there.
  'awaiting-human-review',
  'draft-reset',
  // The design-review gate removed in commit 8a32037. The prose rule further
  // down already excuses this one on the grounds that a dead gate must not
  // keep suppressing findings; the bare code has to say the same thing, and
  // is still the single largest code in site 1's live refusal log at 39 rows.
  'design-unreviewed',
  // The live page could not be read to confirm a schema-only FAQ's questions are
  // on it (faq-render-mode.js's checkSchemaOnlyFaqMatchesVisible). The page was
  // unreachable, not the item's fault; try again later.
  'faq-schema-unverifiable',
]);

// The live page this item's design is compared against could not be read right
// now. The item was never judged; a stale design is deliberately not used
// (live-design-validation.js), so the only honest outcome is retry — without it
// counting toward the cap, or it is retired for a network blip.
const DESIGN_SAMPLE_UNREACHABLE_CODES = new Set(['group-sample-unreachable', 'sample-unreachable']);

// The layout and render gates measured a real browser render and the draft
// disagrees with the site (responsive-preview-gate.js, design-gates.js). The
// automatic repair loop has already rewritten the content and re-measured
// before this is recorded, and a retry re-checks an unchanged page, so it
// reaches the identical verdict. A person has to pick a layout or fix the
// captured template. Not the item's own defect, so not counted toward retiring it.
const LAYOUT_GATE_REASON_CODES = new Set([
  'responsive-regression',
  'render-deviation',
  // style-fidelity-gate.js: rendered into the real page, the block does not carry the page's typography (unstyled text, a different font). A verdict about
  // THIS block, identical on a retry of an unchanged page, so it must never count toward retiring the item or tripping the breaker.
  'style-fidelity-failed',
]);

// Autonomous design repair (generators/lib/design-repair.js) hands a failure it
// diagnosed to whoever owns it and returns one of these instead of a bare gate
// verdict. The item itself is fine; it is waiting on a platform change (a
// design re-capture, a shared-code repair PR, a gate fix) that a person still
// has to merge. Retry later, never count it against the item.
// The one wording for a deferral. The approval stage THROWS these, the classifier RECOGNISES them, and the
// deferral counter QUERIES for them — all three from this single definition so they can never drift apart.
export const DESIGN_DEFERRAL_MESSAGES = Object.freeze({
  capture: 'This page\'s design is being re-captured from the live site; it will be retried once that finishes.',
  shared: 'The cause is in shared platform code and a repair has been requested; this will be retried once it lands.',
});
export const DESIGN_DEFERRAL_FRAGMENTS = Object.freeze({
  capture: 'design is being re-captured from the live site',
  shared: 'cause is in shared platform code and a repair has been requested',
});

export const DESIGN_REPAIR_PENDING_REASON_CODES = new Set([
  'design-capture-refresh-pending',
  'shared-code-repair-pending',
]);

// Every apply()/preview() reason code that is a per-ITEM design verdict: a
// refusal about this one draft, never evidence of a systemic fault, so it must
// not trip the circuit breaker. Single source of truth for auto-remediation's
// refusal marking (it used to rediscover these by matching message prose).
export const ITEM_LEVEL_DESIGN_REASON_CODES = new Set([
  ...LAYOUT_GATE_REASON_CODES,
  ...DESIGN_REPAIR_PENDING_REASON_CODES,
  'design-incomplete',
  'design-integrity-failed',
  'page-design-integrity-failed',
  'needs-design-choice',
]);

// The structured failure of an approve/apply attempt -> what the caller should
// record. A reason code only reaches here if the implementer set one; anything
// else returns null and the caller falls back to message-shape matching.
export function structuredApplyFailure(approved) {
  const reason = approved?.apply_reason;
  if (typeof reason !== 'string' || !reason) return null;
  return { reason, refusal: ITEM_LEVEL_DESIGN_REASON_CODES.has(reason) };
}

// Ordered most-specific first. Each entry cites the observed abandon reason
// it was written for; every one of these is a real string counted in the live
// drafts table, not a hypothetical.
const RULES = [
  // ---- Implementer reason codes ---------------------------------------
  // Exact match only: these are machine-written sentinels, never a substring
  // of a human sentence, so equality keeps them from colliding with the
  // prose rules further down.
  {
    match: (r) => CONFIG_GAP_REASON_CODES.has(r),
    failureClass: FAILURE_CLASS.INVALID_INPUT,
    policy: RETRY_POLICY.NEEDS_HUMAN,
    summary: 'This site’s repository configuration is missing something this fix needs.',
  },
  {
    match: (r) => TRANSIENT_REASON_CODES.has(r),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'The attempt failed on infrastructure, not on the item itself.',
  },
  {
    addedBy: 'design-repair',
    match: (r) => DESIGN_REPAIR_PENDING_REASON_CODES.has(r),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'The cause was found and handed to the platform to repair; this item is retried once that lands.',
  },
  {
    addedBy: 'design-repair',
    match: (r) => LAYOUT_GATE_REASON_CODES.has(r)
      || /breaks the page.s layout at a real device width/i.test(r)
      || /would not look like the rest of the page/i.test(r)
      || /measures differently/i.test(r) && /held rather than shipped/i.test(r),
    failureClass: FAILURE_CLASS.INVALID_INPUT,
    policy: RETRY_POLICY.NEEDS_HUMAN,
    summary: 'Automatic repair tried and could not make this block match the site, so it needs a person to look at the evidence.',
  },
  {
    // schema-repair was asked to fix a page and found nothing wrong. That is
    // an answer, not a failure: the page is already fine (or another draft got
    // there first), so the recommendation closes instead of retrying.
    addedBy: 'design-repair',
    match: (r) => /no malformed or duplicate structured data was found/i.test(r),
    failureClass: null,
    policy: RETRY_POLICY.ALREADY_RESOLVED,
    summary: 'The page has no structured-data problem to repair.',
  },
  {
    addedBy: 'design-repair',
    match: (r) => DESIGN_SAMPLE_UNREACHABLE_CODES.has(r)
      || /design could not be confirmed against the live site/i.test(r) || /group-sample-unreachable/i.test(r)
      // design-repair.js deferrals (action-center.js runDesignRepairStage): the cause was handed to its owner, not the item's.
      || r.toLowerCase().includes(DESIGN_DEFERRAL_FRAGMENTS.capture)
      || r.toLowerCase().includes(DESIGN_DEFERRAL_FRAGMENTS.shared),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'The live page used as the design reference could not be reached; it will be retried.',
  },
  // ---- Human decisions -----------------------------------------------
  // Exact-match sentinels written by the system itself, not prose.
  {
    match: (r) => r === 'pr_closed_without_merge',
    failureClass: null,
    policy: RETRY_POLICY.NEVER,
    // The single largest bucket in the live table (192 rows). A human closed
    // the PR — the draft was fine, the decision was elsewhere.
    summary: 'A reviewer closed the pull request without merging it.',
  },
  {
    match: (r) => r === 'superseded' || r === 'sent_back_to_recommendations',
    failureClass: null,
    policy: RETRY_POLICY.NEVER,
    summary: 'The previous attempt was withdrawn and returned to the board.',
  },

  // ---- Transient / infrastructural ------------------------------------
  {
    match: (r) => /rate limit/i.test(r),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'GitHub’s API rate limit was reached.',
  },
  {
    // github-ops.js endBatchPush turns ANY failure of the batch's one push into this fixed sentence (the real cause is logged and
    // alerted separately). It is an outage on GitHub's side or ours, never a verdict on the item, and it used to be classed as a
    // generator defect, which counted against every draft in the batch and could create a false "capability gap" block.
    match: (r) => /could not be pushed to GitHub right now/i.test(r),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'The batch could not be pushed to GitHub; this is retried and says nothing about the item.',
  },
  {
    // The batch's ONE shared push/PR failed, which fails every pending item
    // at once regardless of content — 54 drafts in a single call on
    // 2026-09-01. Its text is sanitized, so it does NOT match the rate-limit
    // rule above even when a rate limit was the true cause.
    match: (r) => r.startsWith('Batch push/PR failed'),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'The shared batch push or pull request failed for every item at once.',
  },
  {
    // Date-keyed batch branch diverged from the default branch. Self-healing:
    // tomorrow's branch forks fresh.
    match: (r) => /batch branch/i.test(r) && /diverged/i.test(r),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'The shared batch branch diverged and could not be auto-synced.',
  },
  {
    // Bookkeeping, not verdicts: a draft-state reset (lib/draft-ship-state.js)
    // or a recovery script rescuing a stranded row.
    match: (r) => r.startsWith('Stuck at "') || r.startsWith('Recovered:'),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'A stalled attempt was reset so it could be retried cleanly.',
  },
  {
    // The citation-grounding provider was down or out of quota. Tavily's
    // adapter applies a strict daily cap (search-grounding-providers/
    // tavily.js) and expand-content.js turns any search failure into this
    // message. Both are statements about an EXTERNAL dependency's budget,
    // never about the item — but with no rule here they fell through to the
    // ITEM_DEFECT default below and were scored as this generator's own
    // failures. That single misattribution is what demoted expand-content
    // (15 "failures", 0 genuine) and with it 320 open recommendations,
    // 56% of site 1's entire backlog, measured 2026-09-04.
    // Matches BOTH the customer-facing message (persisted to
    // drafts.abandoned_reason) and the short reason CODE a refusal records
    // instead (auto-remediation.js stores err.reason, not err.message, for
    // refusals) — the refusal cap in ship-pacing.js classifies those codes
    // through this same function.
    match: (r) => /citation search is temporarily unavailable/i.test(r)
      || /daily query cap reached/i.test(r)
      || /refusing further citation search/i.test(r)
      || r === 'citation-grounding-unavailable'
      || r === 'citation-grounding-not-configured',
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'The citation-grounding service was unavailable or out of quota.',
  },
  {
    // The LLM provider failed (out of credit, bad key, 5xx, network). Tagged
    // "LLM provider error:" by generators/lib/llm-error.js. Before that tag
    // existed these were reported as "model did not return valid JSON" and
    // scored against the generator — 2026-11-07..18, every auto-fix, because
    // the OpenAI account had no credit. Nothing about the item or generator.
    match: (r) => /^LLM provider error:/i.test(r),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'The AI provider was unavailable (out of credit, key problem or outage).',
  },
  {
    // "Draft was not in a submittable state" — the row moved underneath the
    // shipping loop (another pass, a reconciler sweep, a state reset). Pure
    // bookkeeping about draft lifecycle, the same class as 'Stuck at "'
    // above, and equally not a verdict on the generated content.
    match: (r) => /not in a submittable state/i.test(r),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'The draft changed state before it could be submitted.',
  },

  // ---- Already resolved ------------------------------------------------
  {
    // A schema-only FAQ / Q&A draft whose questions are not the ones the page
    // shows (faq-render-mode.js's checkSchemaOnlyFaqMatchesVisible). The page
    // already has its own visible FAQ, so there is no FAQ to add, and publishing
    // structured data for questions it does not show is exactly what search
    // engines penalise. Nothing was written; the recommendation should close.
    match: (r) => r === 'faq-schema-not-visible' || /FAQ structured data was not published/i.test(r),
    failureClass: null,
    policy: RETRY_POLICY.ALREADY_RESOLVED,
    summary: 'The page already shows its own FAQ, and this draft’s questions are not on it, so no FAQ structured data was published.',
  },
  {
    // "This page already has an FAQPage schema from another FAQ/Q&A draft —
    // nothing left to publish in schema-only mode." (25 live rows.) Another
    // draft won the race and fixed the underlying issue. Retrying cannot
    // succeed and should not: there is nothing left to do.
    match: (r) => /already has an? .*schema/i.test(r) || /nothing left to publish/i.test(r) || /nothing left to apply/i.test(r),
    failureClass: null,
    policy: RETRY_POLICY.ALREADY_RESOLVED,
    summary: 'Another change already fixed this — there is nothing left to apply.',
  },

  // ---- Waiting on a human ----------------------------------------------
  {
    // Config gaps. These mean "waiting on a value or mapping a human
    // supplies", never "this item is unfixable" — and the moment the config
    // lands the item must become eligible again immediately.
    match: (r) => r.includes(NO_FILE_MAPPING_FRAGMENT) || r.includes(NO_MARKERS_CONFIGURED_FRAGMENT),
    failureClass: FAILURE_CLASS.INVALID_INPUT,
    policy: RETRY_POLICY.NEEDS_HUMAN,
    summary: 'This site’s repository mapping is missing an entry this fix needs.',
  },
  {
    // A blog draft cannot be compared with the site's own articles when the site has no real article page to compare against (a repository that
    // was just switched and not captured yet): nothing about the draft is wrong and a retry reaches the same refusal until a person or the
    // Design Agent supplies the reference, so it waits instead of burning the attempt cap (2026-11-25: four Zennly drafts, retried up to three times).
    // Deliberately NOT here: "no sibling FAQ / related-links to copy", "no separate SEO-title field" and "mapped file does not exist". Those were
    // fixed by platform changes and site configuration the same day, so the findings must stay retryable and not be blocked behind a stale verdict.
    match: (r) => /No real "[^"]+" page on this site could be found to compare it against/i.test(r),
    failureClass: FAILURE_CLASS.INVALID_INPUT,
    policy: RETRY_POLICY.NEEDS_HUMAN,
    summary: 'This site has no real article page to compare a blog draft against yet.',
  },
  {
    match: (r) => /no github pat set/i.test(r) || /github app is not configured/i.test(r) || /bad credentials/i.test(r) || /token .*expired/i.test(r) || /no classic pat with .*scope set for code search/i.test(r),
    failureClass: FAILURE_CLASS.CLIENT_REPO,
    policy: RETRY_POLICY.NEEDS_HUMAN,
    summary: 'This site’s GitHub credentials are missing or no longer valid.',
  },
  {
    // "Auto-ship failed: mergeBranchFromBase failed (403): {"message":
    // "Resource not accessible by integration",...}" — GitHub's own
    // documented behavior for a fine-grained PAT hitting the classic
    // "Merge a branch" REST endpoint (github-ops.js's getOrInitBatchBranch
    // calls it to sync every SAME-DAY batch branch with base before a
    // second-or-later draft can push): fine-grained PATs don't support that
    // endpoint at all, the same class of gap this codebase already worked
    // around for /search/code (repo-local-search.js) and for App
    // installation tokens generally. Verified live against site 1
    // (2026-09-11, fine-grained github_pat_... token): 5 identical 403s in
    // one run, all against a GEO (geo-signals) expand-content
    // recommendation whose content had nothing to do with the failure —
    // EVERY draft that day past the first hits this identically, since it's
    // the shared batch-sync step, not anything about the item. Retrying
    // cannot ever succeed with this token type, so ITEM_DEFECT (this
    // codebase's "will recur until the item itself changes") is the wrong
    // read too — nothing about the item can change this. Needs either a
    // classic PAT/App token for this site or a Git-Data-API-based sync that
    // doesn't call /merges at all.
    match: (r) => /mergeBranchFromBase failed \(403\)/.test(r) && /resource not accessible by integration/i.test(r),
    failureClass: FAILURE_CLASS.CLIENT_REPO,
    policy: RETRY_POLICY.NEEDS_HUMAN,
    // Messaging only — this does not change what gets escalated or how
    // (still NEEDS_HUMAN, still no auto-retry, still no merge behavior
    // change): the remediation itself was already fully diagnosed in the
    // comment above when this rule was written, it just wasn't surfaced to
    // whoever reviews the block reason. Attaching it here saves a human a
    // trip back to this file to learn what to actually do about it.
    summary: 'This site’s GitHub token can’t use the branch-merge endpoint the daily batch sync needs (a known fine-grained-PAT limitation) — every draft after the first each day fails identically, regardless of content. Needs either a classic PAT or GitHub App installation token for this site (fine-grained PATs don’t support this endpoint at all), or switching the batch-sync step to the Git Data API instead of /merges.',
  },
  {
    // The repository-local search fallback (repo-local-search.js) is
    // deliberately bounded (MAX_LOCAL_SEARCH_FILES real candidate files per
    // search) rather than a repo-wide grep — for a repo with more real
    // template/markup candidates than that bound, "not found in what was
    // scanned" is not the same claim as "confirmed absent from the whole
    // repo". Auto-retrying this forever would waste the same bounded scan
    // on the same unindexed files every time with no new evidence; treated
    // as needing a human (a bigger bound, a url_file_map entry, or manual
    // confirmation) rather than a transient or per-item defect.
    match: (r) => /could not be fully verified as absent from the repo/i.test(r),
    failureClass: FAILURE_CLASS.CLIENT_REPO,
    policy: RETRY_POLICY.NEEDS_HUMAN,
    summary: 'This repository has more real candidate files than the bounded local search can scan in one pass — needs a url_file_map entry or manual confirmation.',
  },
  {
    // Ordered BEFORE the generic LINK_TARGET_UNRESOLVABLE_FRAGMENT rule below
    // — that rule's message is always a superset of this one's, so it would
    // otherwise win first and give the wrong advice. Since the repo-local
    // search fallback started reading the whole repo as one tarball
    // (2026-09-08), a "no candidates found" result is no longer a bounded
    // sample coming up empty — it's a completed, full-coverage search. When
    // NOTHING page-specific, no configured data source, and no site-wide
    // config file matched either, "add a url_file_map entry" is not just
    // unhelpful here, it's provably wrong: there is nowhere left to map to.
    // Verified live against site 1 (2026-09-11): every "shared header/footer"
    // case this generic rule used to catch (twitter/github/linkedin social
    // links, product doc links, app subdomain logins) now resolves via the
    // site-wide JSON config or a configured data source instead of ever
    // reaching this branch — what's left reaching it is a finding whose href
    // is not hardcoded anywhere in the repo at all, i.e. stale (already fixed
    // on the live site, or never a static link to begin with). Treated as
    // ALREADY_RESOLVED so it stops parking as a human-blocked card telling
    // someone to add a mapping that cannot possibly help, and instead closes
    // so a fresh crawl can re-raise it if it's still genuinely broken.
    match: (r) => r.includes(LINK_CONFIRMED_ABSENT_FRAGMENT),
    failureClass: null,
    policy: RETRY_POLICY.ALREADY_RESOLVED,
    summary: 'This link is not hardcoded anywhere in the repository — the finding is likely stale rather than missing a mapping.',
  },
  {
    // Ordered AFTER the credential and bounded-search rules above so their
    // more specific diagnoses still win on the link-strip messages that carry
    // them; this catches the plain "…none matched." variant, which otherwise
    // fell through to the ITEM_DEFECT default and was read as the agent's own
    // logic failing. It is not: the link is on the page, and the file holding
    // it is unreachable from this site's mapping. Live on site 1 (2026-09-09)
    // that misclassification let 75 findings produce 296 drafts — ship-pacing
    // grants MAX_FAILED_ATTEMPTS per recovery cycle, so an ITEM_DEFECT that
    // can never converge re-drafts on a schedule instead of blocking once.
    //
    // Only reaches here when the fully-searched case above did NOT match —
    // i.e. repo-local search actually found candidate files containing the
    // string (stripLink just couldn't apply cleanly to any of them), which
    // is still a real "the file holding it isn't the one we can safely edit"
    // situation, unlike the confirmed-absent case.
    match: (r) => r.includes(LINK_TARGET_UNRESOLVABLE_FRAGMENT),
    failureClass: FAILURE_CLASS.CLIENT_REPO,
    policy: RETRY_POLICY.NEEDS_HUMAN,
    summary: 'The file containing this link could not be located in the site’s repository — it likely lives in a shared header/footer that needs a url_file_map entry, or code search needs enabling.',
  },
  {
    // The redirect is real (observed live), but no nginx rule for it exists
    // in any file this platform can see — retrying can never find one that
    // isn't there. Needs a human to add the rule (or confirm it lives at a
    // CDN/DNS layer this platform can't touch) rather than keep re-checking
    // identical evidence forever.
    match: (r) => r.includes(REDIRECT_RULE_NOT_FOUND_FRAGMENT),
    failureClass: FAILURE_CLASS.CLIENT_REPO,
    policy: RETRY_POLICY.NEEDS_HUMAN,
    summary: 'No nginx rule for this redirect exists in the repository — it may be defined at a CDN/DNS layer this platform can\'t see or edit.',
  },
  {
    // section-preservation-gate.js's CLAUDE.md §2 refusal — a deliberate,
    // permanent safety block, not an agent defect. It will refuse identically
    // every time; a human must accept the removal by hand or dismiss the
    // finding, so this needs a person's decision rather than another attempt.
    match: (r) => r.includes(SECTION_REMOVAL_REFUSED_FRAGMENT),
    failureClass: FAILURE_CLASS.AGENT_LOGIC,
    policy: RETRY_POLICY.NEEDS_HUMAN,
    summary: 'This fix would remove an existing section from the live page — needs a human decision, not another attempt.',
  },
  {
    // A REMOVED gate (commit 8a32037). Nothing produces this any more, but
    // abandons from before the removal are still inside the 30-day window.
    // Treated as transient rather than a human action precisely so it does
    // not keep suppressing findings whose only failure was a dead gate.
    match: (r) => r.includes(DESIGN_NOT_REVIEWED_FRAGMENT),
    failureClass: FAILURE_CLASS.EXTERNAL_SERVICE,
    policy: RETRY_POLICY.RETRY,
    summary: 'A design-review gate that no longer exists blocked this attempt.',
  },

  // ---- Genuine item defects -------------------------------------------
  {
    // Unlike a missing marker or mapping, this recurs identically FOREVER
    // unless a human hand-edits the draft — trust-compliance.js files the
    // finding precisely so they can. That IS the per-item "cannot be
    // auto-completed" signal the convergence cap exists to catch.
    match: (r) => r.includes(UNVERIFIED_PLACEHOLDER_FRAGMENT),
    failureClass: FAILURE_CLASS.INVALID_INPUT,
    policy: RETRY_POLICY.ITEM_DEFECT,
    summary: 'This fix needs a real value that only a human can supply.',
  },
  {
    // "1 anchor(s) no longer found verbatim in src/pages/about.njk — the
    // source may have changed since this draft was generated."
    match: (r) => /anchor\(s\) no longer found/i.test(r),
    failureClass: FAILURE_CLASS.AGENT_LOGIC,
    policy: RETRY_POLICY.ITEM_DEFECT,
    summary: 'The page changed after this fix was written, so it no longer applies cleanly.',
  },
  {
    // "… does not exist on branch …" / "has no services.* entry in
    // locations.js" / "has no sections." — the target genuinely isn't there.
    match: (r) => /does not exist on branch/i.test(r) || /has no ".*" entry/i.test(r) || /has no sections/i.test(r),
    failureClass: FAILURE_CLASS.INVALID_INPUT,
    policy: RETRY_POLICY.ITEM_DEFECT,
    summary: 'The content this fix targets does not exist yet.',
  },
];

// reason -> { failureClass, retryPolicy, summary }.
//
// An unrecognized reason is ITEM_DEFECT, matching classifyFailure's
// deliberate choice not to default to a benign class: an unknown failure is
// treated as real until someone proves otherwise, so a new failure mode
// surfaces as a capped item rather than retrying forever in silence.
// `legacy: true` classifies as the system did BEFORE autonomous design repair: the rules that change added are skipped.
// Only the read-only audit uses it, to show exactly which stored failures change meaning after deploy.
export function classifyAbandonReason(reason, { legacy = false } = {}) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) {
    return { failureClass: null, retryPolicy: RETRY_POLICY.RETRY, summary: 'The attempt ended without recording a reason.', recognised: false };
  }
  for (const rule of RULES) {
    if (legacy && rule.addedBy) continue;
    if (rule.match(text)) {
      return { failureClass: rule.failureClass, retryPolicy: rule.policy, summary: rule.summary, recognised: true };
    }
  }
  // `recognised: false` says out loud that NO rule matched. The policy stays ITEM_DEFECT so the per-item cap still converges
  // (an unknown failure must not retry forever), but ITEM_DEFECT here means "stop retrying", NOT "we proved the content is
  // wrong". Anything that LEARNS from a failure (generator-learning.js) must check this flag first: a refusal nobody has
  // classified yet is not evidence against the generator's content.
  return {
    failureClass: FAILURE_CLASS.AGENT_LOGIC,
    retryPolicy: RETRY_POLICY.ITEM_DEFECT,
    summary: 'This fix could not be applied automatically.',
    recognised: false,
  };
}

// True when a failure with this policy should leave the recommendation
// available for another automatic attempt. NEEDS_HUMAN and ALREADY_RESOLVED
// both stop the loop; NEVER stops the AUTOMATIC loop but the card still
// returns to the board for a person to decide on.
export function isAutoRetryable(policy) {
  return policy === RETRY_POLICY.RETRY || policy === RETRY_POLICY.ITEM_DEFECT;
}

// True when the classifier matched a rule for this reason. A reason that matched none is UNRECOGNISED: capped like any other
// item failure, but never to be taught as a genuine content defect until a person or the capability-gap investigation names it.
export function isRecognisedFailure(reason) {
  return classifyAbandonReason(reason).recognised === true;
}
