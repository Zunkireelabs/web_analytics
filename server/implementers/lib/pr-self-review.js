// The agent's review of the PR it just opened.
//
// "PR opened" is not "work finished". This module is what turns a PR the
// agent created into either an honest READY_FOR_HUMAN_REVIEW or an honest
// NEEDS_HUMAN_REVIEW with the exact reason attached — so a reviewer opening
// Action Center knows whether the thing waiting for them is actually ready,
// instead of discovering a red check themselves.
//
// WHERE THIS RUNS: inside routes/action-center.js's checkDraftPrStatus, the
// one existing GitHub-aware path, already driven three ways (the manual
// button, the PR webhook, and job.js's hourly poll). It deliberately adds NO
// new poller. lib/action-center-reconciler.js's own header forbids it from
// calling GitHub — "PR truth already has an owner... A second poller would
// double the API spend against the same rate limit that already abandoned 113
// drafts in one hour on 2026-09-01" — and that reasoning applies here too.
//
// WHAT IT NEVER DOES: merge. There is no merge call in this file, and
// agent_review_state (migration 146) cannot express 'merged'. Reaching
// drafts.status='implemented' still requires GitHub reporting pr_state
// 'merged', which only a human's action produces.

import { getCheckRunsForRef } from '../../github/client.js';
import { CLIENT_BUILD_CHECK_NAME } from './rendering-gate.js';

export const AGENT_REVIEW_STATE = {
  REVIEWING: 'agent_reviewing',
  FIXING: 'agent_fixing',
  READY: 'ready_for_human_review',
  NEEDS_HUMAN: 'needs_human_review',
};

// The taxonomy from the brief, kept as the four categories rather than
// collapsed — the difference between B and D is what decides retry vs.
// escalate, and between A and C what decides act vs. hand over.
export const FAILURE_CATEGORY = {
  SAFE_TO_FIX: 'A_safe_to_fix',
  TRANSIENT: 'B_transient',
  UNSAFE: 'C_unsafe_for_autonomous_fix',
  ITEM_DEFECT: 'D_item_defect',
};

// A defect the agent may correct on its own PR branch must satisfy all three:
//
//   1. The fault is in content THIS draft generated — not in the client's
//      repo, their tests, or their build config. The agent may correct its
//      own work; it may not start editing a client's codebase because a
//      check went red.
//   2. The correction is deterministic — recomputable from the draft's own
//      content by an existing validator, with no judgment call.
//   3. It is in scope — the fix touches only the files this draft already
//      wrote.
//
// Anything failing any of the three is not category A, however obvious the
// fix might look. That is the whole boundary, and it is deliberately narrow:
// an agent pushing unreviewed commits into a client's repository on a guess
// is a worse failure than a red check waiting for a person.
const SAFE_TO_FIX_CHECKS = new Set([CLIENT_BUILD_CHECK_NAME]);

// Failures within the safe-to-fix checks that are still NOT safe, because the
// defect is not in our generated content. rendering-validation runs two
// independent steps (see rendering-validation-templates/workflow.yml): the
// raw-Markdown/unresolved-template scan, which examines what we wrote, and
// check-family-siblings, which detects a change leaking into sibling pages of
// a shared data-driven template family. The second is a blast-radius problem
// in the client's own template structure — regenerating our content does not
// address it, and guessing at it would mean editing shared templates.
const UNSAFE_WITHIN_SAFE_CHECK = [
  { pattern: /sibling|family/i, reason: 'the change affected sibling pages of a shared template family — a blast-radius problem in the client\'s templates, not a defect in this draft\'s own generated content' },
];

// GitHub-side conditions that are the infrastructure failing rather than the
// change being wrong. Retried under the existing policy; never escalated as
// if the content were at fault.
const TRANSIENT_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'stale']);

export const MAX_AGENT_FIX_ATTEMPTS = 2;

// Classifies ONE failing check run. Pure — no I/O, no GitHub, no DB — so the
// decision can be tested directly rather than inferred from behaviour.
export function classifyCheckFailure(run, { draftGeneratedFiles = [] } = {}) {
  const name = run?.name || 'unnamed check';

  if (TRANSIENT_CONCLUSIONS.has(run?.conclusion)) {
    return {
      category: FAILURE_CATEGORY.TRANSIENT,
      check: name,
      reason: `"${name}" concluded "${run.conclusion}", which is the CI run not completing rather than the change being wrong. Retried under the existing policy; the content is not implicated.`,
    };
  }

  if (!SAFE_TO_FIX_CHECKS.has(name)) {
    // Everything the agent didn't author the inputs to: the client's unit
    // tests, integration tests, type checks, lint, their build. A red one is
    // real information and is recorded in full, but repairing it means
    // changing the client's code on a guess.
    return {
      category: FAILURE_CATEGORY.UNSAFE,
      check: name,
      reason: `"${name}" is a check whose inputs this draft does not own. Its failure is recorded in full, but correcting it would mean editing the client's own code or configuration on an inference — outside what this draft was authorised to change.`,
    };
  }

  const message = `${run?.output?.title || ''} ${run?.output?.summary || ''}`;
  for (const { pattern, reason } of UNSAFE_WITHIN_SAFE_CHECK) {
    if (pattern.test(message)) {
      return { category: FAILURE_CATEGORY.UNSAFE, check: name, reason: `"${name}" failed, but ${reason}.` };
    }
  }

  if (!draftGeneratedFiles.length) {
    // Without knowing which files this draft wrote, "in scope" cannot be
    // established, so requirement 3 fails. Refusing here is the same
    // discipline url-file-map.js applies to an unmapped page: an honest stop
    // rather than a guess.
    return {
      category: FAILURE_CATEGORY.ITEM_DEFECT,
      check: name,
      reason: `"${name}" failed and this draft has no recorded generated files, so the scope of a corrective edit cannot be established. Treated as a real defect rather than guessed at.`,
    };
  }

  return {
    category: FAILURE_CATEGORY.SAFE_TO_FIX,
    check: name,
    reason: `"${name}" failed on content this draft generated (${draftGeneratedFiles.join(', ')}), and the correction is recomputable from the draft's own content by the same validator that rejected it.`,
  };
}

// Reads every check run on the PR head and reduces them to one decision.
// Deliberately reads ALL of them: before this, only the single check named
// rendering-validation was ever looked at, so a failing unit test, type error
// or build break on the same PR was invisible to this app and the draft
// looked clean.
export async function reviewPrChecks(site, ref, draft, { getCheckRuns = getCheckRunsForRef } = {}) {
  let runs;
  try {
    runs = await getCheckRuns(site, ref);
  } catch (err) {
    // Cannot see the checks — that is not the same as the checks passing, and
    // must never be reported as ready.
    return {
      state: AGENT_REVIEW_STATE.NEEDS_HUMAN,
      checksVisible: false,
      reason: `Could not read check runs for "${ref}": ${err.message}. Unknown is not the same as green, so this is being handed over rather than reported ready.`,
      failures: [], pending: [], passed: [],
    };
  }

  const pending = runs.filter((r) => r.status !== 'completed').map((r) => r.name);
  const completed = runs.filter((r) => r.status === 'completed');
  const failed = completed.filter((r) => r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped');
  const passed = completed.filter((r) => r.conclusion === 'success').map((r) => r.name);

  const draftGeneratedFiles = generatedFilePaths(draft);
  const failures = failed.map((run) => ({ ...classifyCheckFailure(run, { draftGeneratedFiles }), conclusion: run.conclusion }));

  if (pending.length) {
    // Still running. Not ready, not failed — say so rather than resolving it
    // either way, and let the next poll decide.
    return { state: AGENT_REVIEW_STATE.REVIEWING, checksVisible: true, reason: `Waiting on ${pending.length} check(s) still running: ${pending.join(', ')}.`, failures, pending, passed };
  }

  if (!failures.length) {
    if (!runs.length) {
      // No checks configured at all. Honest about what that does and does not
      // prove: nothing was verified, so nothing can be asserted about it.
      return { state: AGENT_REVIEW_STATE.READY, checksVisible: true, noChecksConfigured: true, reason: 'No CI checks are configured on this repository, so none could be verified. The PR is ready for human review on that basis alone — nothing here confirms the change builds.', failures: [], pending: [], passed };
    }
    return { state: AGENT_REVIEW_STATE.READY, checksVisible: true, reason: `All ${passed.length} check(s) passed: ${passed.join(', ')}.`, failures: [], pending: [], passed };
  }

  const safeToFix = failures.filter((f) => f.category === FAILURE_CATEGORY.SAFE_TO_FIX);
  const transient = failures.filter((f) => f.category === FAILURE_CATEGORY.TRANSIENT);
  const blocking = failures.filter((f) => f.category === FAILURE_CATEGORY.UNSAFE || f.category === FAILURE_CATEGORY.ITEM_DEFECT);

  // A single unfixable failure decides the outcome even if others are
  // fixable. Fixing the tractable half and calling the PR ready would hide
  // the rest, which is the one thing this module exists to prevent.
  if (blocking.length) {
    return { state: AGENT_REVIEW_STATE.NEEDS_HUMAN, checksVisible: true, reason: blocking.map((f) => f.reason).join(' '), failures, pending, passed };
  }

  if ((draft?.agent_fix_attempts ?? 0) >= MAX_AGENT_FIX_ATTEMPTS) {
    // Tried and still failing. Whatever the classifier believed, the evidence
    // now says the agent cannot fix this, so it stops rather than looping —
    // the same convergence discipline ship-pacing.js applies upstream.
    return {
      state: AGENT_REVIEW_STATE.NEEDS_HUMAN, checksVisible: true,
      reason: `Attempted ${draft.agent_fix_attempts} corrective push(es) and ${failures.map((f) => f.check).join(', ')} still fails. Escalating rather than retrying further.`,
      failures, pending, passed,
    };
  }

  if (safeToFix.length) {
    return { state: AGENT_REVIEW_STATE.FIXING, checksVisible: true, reason: safeToFix.map((f) => f.reason).join(' '), failures, pending, passed };
  }

  // Only transient failures left — leave it in review so the next poll
  // re-reads rather than declaring either outcome.
  return { state: AGENT_REVIEW_STATE.REVIEWING, checksVisible: true, reason: transient.map((f) => f.reason).join(' '), failures, pending, passed };
}

// The files this draft actually wrote. appliedFiles is recorded at
// branch-push time (store/drafts.js's markDraftBranchPushed).
export function generatedFilePaths(draft) {
  const applied = draft?.content?.appliedFiles;
  if (!Array.isArray(applied)) return [];
  return applied.map((f) => f?.filePath).filter(Boolean);
}
