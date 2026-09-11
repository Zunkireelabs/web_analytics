import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAbandonReason, isAutoRetryable, RETRY_POLICY } from './attempt-classification.js';
import { FAILURE_CLASS } from './failure-classification.js';

// Every string below is a REAL abandoned_reason counted in the live drafts
// table on 2026-09-03, with its live row count. They are the whole point of
// the test: this classifier's only job is to be right about the failures that
// actually happen, and the previous implementation (a list of SQL NOT LIKE
// clauses) had no way to assert that at all.

test('a closed pull request is a human decision, never the item’s fault', () => {
  // 192 live rows — the single largest bucket.
  const { retryPolicy } = classifyAbandonReason('pr_closed_without_merge');
  assert.equal(retryPolicy, RETRY_POLICY.NEVER);
  assert.equal(isAutoRetryable(retryPolicy), false);
});

test('a shared batch push failure is transient, not a verdict on any item', () => {
  // 54 + 26 live rows. Sanitized text, so it does NOT contain "rate limit"
  // even when a rate limit was the real cause — the exact reason this needs
  // its own rule rather than relying on the rate-limit matcher.
  const { retryPolicy } = classifyAbandonReason(
    'Batch push/PR failed: This pull request could not be opened right now — our team has been notified. (ref: b8e86471)',
  );
  assert.equal(retryPolicy, RETRY_POLICY.RETRY);
});

test('a diverged batch branch is transient — tomorrow’s branch forks fresh', () => {
  // 45 live rows.
  const { retryPolicy } = classifyAbandonReason(
    "Auto-ship failed: Today's batch branch (action-center/batch-1-2026-08-30) has diverged from main and couldn't be auto-synced — resolve the conflict manually on GitHub before more drafts can be pushed today.",
  );
  assert.equal(retryPolicy, RETRY_POLICY.RETRY);
});

test('a removed design-review gate does not hold findings back', () => {
  // 39 live rows, all produced by a gate commit 8a32037 deleted. Counting
  // these would retire findings whose only failure was a gate that no longer
  // exists — 7 findings on site 1 were capped for exactly this reason.
  const { retryPolicy } = classifyAbandonReason(
    "Auto-ship failed: This site's design has not been reviewed yet — review and approve it (Clients → this site → Review this site's design) before styled content can ship.",
  );
  assert.equal(retryPolicy, RETRY_POLICY.RETRY);
});

test('a missing url_file_map entry waits on a human, and stops retrying', () => {
  // 11 live rows. Retrying cannot succeed until someone runs connect-repo,
  // so the card blocks with the reason instead of burning spend.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: No url_file_map entry matches "https://dev-web.zunkireelabs.com/gaas/" — add one via `npm run connect-repo` before this can be applied.',
  );
  assert.equal(retryPolicy, RETRY_POLICY.NEEDS_HUMAN);
  assert.equal(isAutoRetryable(retryPolicy), false);
});

test('a broken link genuinely absent from the whole repo is stale, not a mapping gap', () => {
  // Real message shape produced by backend.js's computeBrokenLinkFixMerge
  // once repo-local search covers the whole repo (2026-09-08): a human
  // cannot fix this by adding a url_file_map entry, because full-coverage
  // search already proved there is nothing left to map to. Verified live
  // against site 1 (2026-09-11) — a pankey.org citation link on a dental
  // blog post that no longer exists anywhere in the repo.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: No file could be found or safely stripped for href="https://pankey.org/the-era-of-the-ai-virtual-assistants-in-dentistry/" across 1 known source page(s) (0 have no url_file_map entry; 1 mapped file(s) don\'t contain this link); also checked the site-wide link config file, no match — a full repository search (not a bounded sample) found this href hardcoded nowhere in it. This link is confirmed absent from every real candidate file in the repo — the finding is likely stale rather than missing a mapping.',
  );
  assert.equal(retryPolicy, RETRY_POLICY.ALREADY_RESOLVED);
  assert.equal(isAutoRetryable(retryPolicy), false);
});

test('a broken link with real search candidates that just don’t match still waits on a human', () => {
  // The narrower fragment above must not swallow this case: repo-local
  // search DID find files containing the string, stripLink just couldn't
  // apply cleanly — genuinely still a "the right file is unreachable" gap.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: No file could be found or safely stripped for href="https://github.com/zunkiree" across 1 known source page(s) (0 have no url_file_map entry; 1 mapped file(s) don\'t contain this link) — also checked 4 repository-local search candidate(s), none matched.',
  );
  assert.equal(retryPolicy, RETRY_POLICY.NEEDS_HUMAN);
});

test('a fine-grained PAT unable to use the merge-branch endpoint waits on a human, not the item', () => {
  // Real message, site 1, 2026-09-11 — 5 identical occurrences in one run,
  // all against different GEO content with nothing wrong with any of it.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: mergeBranchFromBase failed (403): {"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/branches/branches#merge-a-branch","status":"403"}',
  );
  assert.equal(retryPolicy, RETRY_POLICY.NEEDS_HUMAN);
  assert.equal(isAutoRetryable(retryPolicy), false);
});

test('missing markers wait on a human too', () => {
  // 10 + 9 live rows (Facebook Pixel and GA4).
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: No markers configured for "https://zunkireelabs.com/" — add e.g. {"analyticsScriptGa4":"ANALYTICSSCRIPTGA4"} to url_file_map.defaults.placements["analytics-install"].markers',
  );
  assert.equal(retryPolicy, RETRY_POLICY.NEEDS_HUMAN);
});

test('an issue another draft already fixed is resolved, not retried', () => {
  // 25 live rows. This one matters most: it is the reason a single finding
  // was drafted 24 times across 6 findings, each attempt reaching the
  // identical "nothing left to do" outcome.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: This page already has an FAQPage schema from another FAQ/Q&A draft — nothing left to publish in schema-only mode.',
  );
  assert.equal(retryPolicy, RETRY_POLICY.ALREADY_RESOLVED);
  assert.equal(isAutoRetryable(retryPolicy), false);
});

test('an anchor that no longer matches is a real defect in the item', () => {
  // 7 + 6 live rows. The page changed after the draft was written; this WILL
  // recur identically until the item is regenerated, so it counts.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: 1 anchor(s) no longer found verbatim in src/pages/about.njk — the source may have changed since this draft was generated.',
  );
  assert.equal(retryPolicy, RETRY_POLICY.ITEM_DEFECT);
});

test('content that does not exist yet is a real defect in the item', () => {
  // 3 live rows each for several city/service combinations.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: "pokhara" has no "services.web-development" entry in src/_data/locations.js — this page has no unique content for that section yet.',
  );
  assert.equal(retryPolicy, RETRY_POLICY.ITEM_DEFECT);
});

test('a rate limit is transient wherever it appears', () => {
  const { retryPolicy } = classifyAbandonReason('Auto-ship failed: GitHub API rate limit exceeded for user ID 12345');
  assert.equal(retryPolicy, RETRY_POLICY.RETRY);
});

test('an unconfigured GitHub App is a missing-credential wait, same as a missing PAT', () => {
  // Regression: client.js used to blame "No GitHub PAT set" even when the site
  // is on the App path (github_app_installation_id set) and the real gap is
  // GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_B64 — this pattern must classify the
  // same way the PAT message always has, not fall through to a generator defect.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: GitHub App is not configured — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_B64',
  );
  assert.equal(retryPolicy, RETRY_POLICY.NEEDS_HUMAN);
  assert.equal(isAutoRetryable(retryPolicy), false);
});

test('a missing code-search PAT is a config wait, not a per-item content defect', () => {
  // Regression: before this rule existed, "No file could be found... code
  // search fallback failed: No classic PAT with repo scope set for code
  // search" had no matching rule and fell through to the unrecognized-text
  // default (ITEM_DEFECT) — wrongly implying each individual broken-link-fix
  // item was itself broken, when the real cause is a single missing
  // site-wide credential (GITHUB_PAT_SEARCH / GITHUB_SEARCH_PAT) that blocks
  // every broken-link-fix needing the code-search fallback identically.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: No file could be found or safely stripped for href="https://crm.zunkiree.com" across 1 known source page(s) (0 have no url_file_map entry; 1 mapped file(s) don\'t contain this link) — code search fallback failed: No classic PAT with "repo" scope set for code search — set GITHUB_PAT_SEARCH (or the global GITHUB_SEARCH_PAT) to enable the code-search fallback..',
  );
  assert.equal(retryPolicy, RETRY_POLICY.NEEDS_HUMAN);
  assert.equal(isAutoRetryable(retryPolicy), false);
});

test('an incomplete bounded repository search waits on a human, not a per-item defect or an infinite silent retry', () => {
  // Regression: the repository-local search fallback (repo-local-search.js)
  // is deliberately bounded — for a repo with more real candidate files
  // than that bound, "not found in what was scanned" must never be reported
  // as a confident per-item defect (implying THIS href is definitely
  // nowhere), nor silently retried forever against the same unscanned
  // files with no new evidence.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: No file could be found or safely stripped for href="https://dead.example/" across 1 known source page(s) (0 have no url_file_map entry; 1 mapped file(s) don\'t contain this link) — also checked 3 repository-local search candidate(s), none matched. The repository has more real candidate files than a bounded search can safely scan in one pass, and none of the scanned files matched — this could not be fully verified as absent from the repo.',
  );
  assert.equal(retryPolicy, RETRY_POLICY.NEEDS_HUMAN);
  assert.equal(isAutoRetryable(retryPolicy), false);
});

test('an unresolvable link target waits on a human, and does not re-draft on every recovery cycle', () => {
  // Regression, measured live on site 1 (2026-09-09): the plain
  // "…none matched." variant carried neither the credential phrase nor the
  // bounded-search phrase, so it fell through to the ITEM_DEFECT default.
  // ITEM_DEFECT is not merely "wrong label" here — ship-pacing grants
  // MAX_FAILED_ATTEMPTS afresh per recovery cycle, so 75 findings produced
  // 296 drafts, re-failing identically from 2026-08-23 onward.
  const { retryPolicy, failureClass } = classifyAbandonReason(
    'Auto-ship failed: No file could be found or safely stripped for href="https://beed.com.np" across 1 known source page(s) (0 have no url_file_map entry; 1 mapped file(s) don\'t contain this link) — also checked 1 repository-local search candidate(s), none matched.',
  );
  assert.equal(retryPolicy, RETRY_POLICY.NEEDS_HUMAN);
  assert.equal(failureClass, FAILURE_CLASS.CLIENT_REPO);
  assert.equal(isAutoRetryable(retryPolicy), false);
});

test('bookkeeping resets are not verdicts', () => {
  // 31 live rows from the one-off stranded-draft recovery script.
  assert.equal(
    classifyAbandonReason('Recovered: stranded at submitted_for_approval by the pre-fix swallow-and-strand gap in the unattended auto-ship path (2026-08-25).').retryPolicy,
    RETRY_POLICY.RETRY,
  );
  assert.equal(
    classifyAbandonReason('Stuck at "approved" and not resumable — abandoned so a fresh draft can be generated.').retryPolicy,
    RETRY_POLICY.RETRY,
  );
});

test('the reclaim sentinel is a withdrawal, not a failure', () => {
  assert.equal(classifyAbandonReason('sent_back_to_recommendations').retryPolicy, RETRY_POLICY.NEVER);
});

test('an unverified placeholder counts, because no config change ever clears it', () => {
  // Deliberately NOT treated as a config gap: unlike a missing marker, this
  // recurs identically forever unless a human hand-edits the draft.
  const { retryPolicy } = classifyAbandonReason(
    'Auto-ship failed: refusing to publish an unverified placeholder field',
  );
  assert.equal(retryPolicy, RETRY_POLICY.ITEM_DEFECT);
});

test('an unrecognized failure counts rather than retrying forever in silence', () => {
  // Mirrors classifyFailure's deliberate refusal to default to a benign
  // class: a new failure mode must surface, not be absorbed as "probably
  // transient" and retried indefinitely.
  const { retryPolicy } = classifyAbandonReason('Auto-ship failed: something nobody has seen before');
  assert.equal(retryPolicy, RETRY_POLICY.ITEM_DEFECT);
});

test('an empty reason is retryable rather than held against the item', () => {
  assert.equal(classifyAbandonReason(null).retryPolicy, RETRY_POLICY.RETRY);
  assert.equal(classifyAbandonReason('').retryPolicy, RETRY_POLICY.RETRY);
});

// ---- Implementer reason CODES (the refusal path) -----------------------
// auto-remediation.js records a refusal's `err.reason` — the implementers'
// short `{ ok: false, reason }` code — into generator_outcomes.detail, and
// countRefusalsByRecommendation classifies THAT to decide whether the refusal
// was the item's own fault. A bare code matches none of the prose rules, so
// before these every code fell through to the ITEM_DEFECT default and counted
// against the item — retiring, among others, site 1's GA4 and Meta Pixel
// analytics-install recommendations at 12 and 15 "honest refusals" that were
// every one of them a self-healing missing marker.

test('a config-gap reason CODE is a human gap, not an item defect', () => {
  for (const code of ['no-insertion-marker', 'no-file-mapping', 'no-markers-configured', 'no-repo']) {
    assert.equal(classifyAbandonReason(code).retryPolicy, RETRY_POLICY.NEEDS_HUMAN, code);
  }
});

test('the code form agrees with the prose form of the same gap', () => {
  // These two describe one situation and must never disagree about it.
  assert.equal(
    classifyAbandonReason('no-file-mapping').retryPolicy,
    classifyAbandonReason('No url_file_map entry matches "/pricing".').retryPolicy,
  );
});

test('an infrastructure reason CODE is transient, not an item defect', () => {
  for (const code of ['github-error', 'batch-branch-conflicted', 'pr-open-failed', 'unreachable']) {
    assert.equal(classifyAbandonReason(code).retryPolicy, RETRY_POLICY.RETRY, code);
  }
});

test('draft lifecycle-state reason CODES say nothing about the item', () => {
  // learned-repair.js excuses exactly these two for its own reuse scoring;
  // the refusal cap has to reach the same verdict from the same input.
  for (const code of ['awaiting-human-review', 'draft-reset', 'design-unreviewed']) {
    assert.equal(classifyAbandonReason(code).retryPolicy, RETRY_POLICY.RETRY, code);
  }
});

test('a genuinely item-specific reason CODE still counts against the item', () => {
  // The caps exist for a reason: only codes that say nothing about the item
  // were excused, and nothing here may quietly join them.
  for (const code of ['invalid-edit', 'draft-not-ready', 'quality-gate-exhausted', 'no-match']) {
    assert.equal(classifyAbandonReason(code).retryPolicy, RETRY_POLICY.ITEM_DEFECT, code);
  }
});
