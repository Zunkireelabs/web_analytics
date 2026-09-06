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
//      content, with no judgment call about the client's intent.
//   3. It is in scope — the fix touches only the files this draft already
//      wrote.
//   4. It is EXECUTABLE HERE — this app can actually perform it without
//      running the client repository's own tooling.
//
// Anything failing any of the four is not category A, however obvious the fix
// might look. The boundary is deliberately narrow: an agent pushing
// unreviewed commits into a client's repository on a guess is a worse failure
// than a red check waiting for a person.
//
// WHY THIS SET IS CURRENTLY EMPTY — this is a real architectural constraint,
// not an omission, and it is worth reading before adding to it.
//
// Formatter/linter autofix (prettier --write, eslint --fix) fails requirement
// 4. This app never holds the client's repository: no working tree, no
// node_modules, no plugins. Running eslint --fix means loading their eslint
// config, which require()s arbitrary code from their repo — the exact
// remote-code-execution surface this system deliberately refuses, and the
// reason the rendering-validation build runs in GitHub Actions inside the
// client's own sandbox rather than on this app's infrastructure (see the
// action-center-onboarding skill's build-location decision). Prettier without
// their config would reformat to OUR defaults and fight their setup, which is
// a new defect rather than a fix.
//
// Raw-Markdown rendering failures fail requirement 2. checkRenderCapability
// already fails closed BEFORE a PR exists — a PR is never opened for a file
// whose target this app cannot positively vouch for as markdown-safe. So
// rendering-validation failing on raw Markdown in the client's CI does not
// mean the generated content is malformed; it means the site's recorded
// renderCapabilities is wrong (a human declared an extension markdown-capable
// when that target's build does not run a markdown pass). Rewriting the
// content would paper over an incorrect capability declaration that will
// mis-render every future page for that site. The correct fix is to that
// metadata, and it needs a person who knows the client's build.
//
// The honest place to execute a formatter autofix is the client's own
// GitHub Actions sandbox — the same venue rendering-validation already uses.
// That is a real option, but it is a new workflow in someone else's repo, so
// it is a deliberate choice to make rather than something to infer from a red
// check.
const SAFE_TO_FIX_CHECKS = new Set([]);

// Checks whose failure is a formatting/lint problem. Recognised as its own
// category so the reason recorded on the draft names the real situation —
// "this is deterministically fixable, but not from here" — rather than
// disappearing into a generic unsafe bucket. See SAFE_TO_FIX_CHECKS above.
const FORMATTING_CHECK_PATTERN = /\b(lint|eslint|prettier|format|formatting|style)\b/i;

// The rendering-validation check's two independent steps fail for different
// reasons and neither is a content defect this app can patch. Named
// separately so the recorded reason points at the actual cause.
const RENDERING_FAILURE_DIAGNOSES = [
  {
    pattern: /sibling|family/i,
    diagnosis: 'the change reached sibling pages of a shared, data-driven template family. That is a blast-radius property of the client\'s own templates, not a defect in this draft\'s content — correcting it means changing a shared template, which is outside what this draft was authorised to touch.',
  },
  {
    pattern: /markdown|unresolved|\{\{|\{%/i,
    diagnosis: 'the built page contains raw Markdown or unresolved template syntax. Because checkRenderCapability already fails closed before a PR is opened, this does not indicate malformed generated content — it indicates this site\'s recorded url_file_map.renderCapabilities claims an extension renders Markdown when that target\'s build does not. Rewriting the page would hide an incorrect capability declaration that will mis-render every future page for this site; the fix belongs in that metadata.',
  },
];

// GitHub-side conditions that are the infrastructure failing rather than the
// change being wrong. Retried under the existing policy; never escalated as
// if the content were at fault.
const TRANSIENT_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'stale']);

// A PR whose branch cannot merge cleanly. Explicitly never auto-fixed:
// resolving a conflict means choosing between two people's intended changes,
// which is a judgment call, and the batch branch can carry several drafts
// (github-ops.js's openPrForBranch) so a bad resolution would corrupt work
// this draft does not own.
export function classifyMergeability(mergeableState) {
  if (!mergeableState || ['clean', 'unstable', 'has_hooks', 'unknown'].includes(mergeableState)) return null;
  return {
    category: FAILURE_CATEGORY.UNSAFE,
    check: 'merge-state',
    reason: `GitHub reports this PR's branch as "${mergeableState}" — it cannot merge cleanly. Resolving that means choosing between two people's intended changes, and this branch may carry several drafts batched together, so an automatic resolution could corrupt work this draft does not own.`,
  };
}

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

  const message = `${run?.output?.title || ''} ${run?.output?.summary || ''}`;

  // rendering-validation — the one check whose inputs this draft DOES own.
  // Still not auto-fixed, but the recorded reason names which of its two
  // steps failed and what actually needs changing, so the human it escalates
  // to starts from a diagnosis rather than a red X.
  if (name === CLIENT_BUILD_CHECK_NAME) {
    for (const { pattern, diagnosis } of RENDERING_FAILURE_DIAGNOSES) {
      if (pattern.test(message)) {
        return { category: FAILURE_CATEGORY.UNSAFE, check: name, reason: `"${name}" failed: ${diagnosis}` };
      }
    }
    if (!draftGeneratedFiles.length) {
      // Without knowing which files this draft wrote, scope cannot be
      // established. Same discipline url-file-map.js applies to an unmapped
      // page: an honest stop rather than a guess.
      return {
        category: FAILURE_CATEGORY.ITEM_DEFECT,
        check: name,
        reason: `"${name}" failed and this draft has no recorded generated files, so the scope of any corrective edit cannot be established. Treated as a real defect rather than guessed at.`,
      };
    }
    return {
      category: FAILURE_CATEGORY.ITEM_DEFECT,
      check: name,
      reason: `"${name}" failed on this draft's generated files (${draftGeneratedFiles.join(', ')}) for a reason its output does not identify. Treated as a real defect — an unrecognised failure is real until shown otherwise.`,
    };
  }

  // Formatting/lint. Deterministically fixable in principle, and explicitly
  // NOT fixable from here — see SAFE_TO_FIX_CHECKS. Named as its own case so
  // the reason says which it is.
  if (FORMATTING_CHECK_PATTERN.test(name)) {
    return {
      category: FAILURE_CATEGORY.UNSAFE,
      check: name,
      reason: `"${name}" is a formatting/lint check. Its fix is deterministic in principle, but running it requires the client repository's own tooling and configuration (their eslint config resolves plugin code from their repo), which this app deliberately never executes — the same reason the build check runs in their GitHub Actions sandbox rather than here. Escalated rather than approximated with different formatting settings.`,
    };
  }

  if (SAFE_TO_FIX_CHECKS.has(name)) {
    return {
      category: FAILURE_CATEGORY.SAFE_TO_FIX,
      check: name,
      reason: `"${name}" failed on content this draft generated (${draftGeneratedFiles.join(', ')}), and the correction is recomputable here from the draft's own content.`,
    };
  }

  // Everything else: the client's unit tests, integration tests, type checks,
  // their build. Real information, recorded in full — but repairing it means
  // changing the client's code on an inference.
  return {
    category: FAILURE_CATEGORY.UNSAFE,
    check: name,
    reason: `"${name}" is a check whose inputs this draft does not own. Its failure is recorded in full, but correcting it would mean editing the client's own code or configuration on an inference — outside what this draft was authorised to change.`,
  };
}

// Reads every check run on the PR head and reduces them to one decision.
// Deliberately reads ALL of them: before this, only the single check named
// rendering-validation was ever looked at, so a failing unit test, type error
// or build break on the same PR was invisible to this app and the draft
// looked clean.
export async function reviewPrChecks(site, ref, draft, { getCheckRuns = getCheckRunsForRef, mergeableState = null } = {}) {
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

  // A branch that cannot merge is a blocking problem even when every check is
  // green, so it joins the failure list rather than being reported separately.
  // Before this, mergeable_state was recorded for display and decided nothing.
  const mergeConflict = classifyMergeability(mergeableState);
  if (mergeConflict) failures.push({ ...mergeConflict, conclusion: mergeableState });

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
