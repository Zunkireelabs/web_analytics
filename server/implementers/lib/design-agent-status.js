// Honest, multi-tenant Design Agent capability-generation status, for the
// Action Center's blocked-recommendation message specifically.
//
// This is deliberately NOT a rewrite of design-drift.js's
// resolveOrCreateComponentTemplate — that function already derives an
// honest, job-status-aware message for its own caller (generateDraft's hot
// apply-time path: 'derivation-queued' / 'derivation-retry-queued' /
// 'derivation-queue-failed', see its own doc comments), and it stays exactly
// as it is. The gap this module closes is different: agents/lib/
// recommendation-gates.js sets a recommendation's LIST-VIEW blocked_reason
// from design-drift.js's SYNCHRONOUS, in-memory-only componentTemplateVerification/
// contentWrapperAvailability (deliberately pure — see that file's own "safe
// on the hot path" comment, since it's also called from generateDraft's hot
// path in routes/action-center.js). Being synchronous, that gate has never
// been able to ask "did the last attempt actually fail?" — it always
// returned the same static "queued, no action needed" text, whether nothing
// had ever run, a job was genuinely in flight, or every attempt so far had
// failed. That mismatch is the real incident this module exists to fix
// (recommendations 60-63 etc. on site 1, 2026-08-24 — job 1091's own
// predecessor sat 'failed' for hours while the Action Center kept claiming
// nothing needed doing).
//
// recommendation-gates.js's evaluate() is already async and already does
// several DB/network reads per candidate (repo tree, soft-404 fingerprint,
// etc.) with its own per-pass caches — this fits the same shape: one query
// per site per pass (cached by the caller), not a hot per-request path.
import { getRecentDesignAgentJobs, DESIGN_PROFILE_JOB_KEY } from '../../store/execution-jobs.js';

export const DESIGN_AGENT_STATE = Object.freeze({
  NEVER_ATTEMPTED: 'never_attempted',
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
});

// 2+ consecutive failed job rows (each already internally retried up to
// worker.js's own maxAttempts before being marked 'failed' at all — see
// RETRY_BACKOFF_MS/runWithRetry there) is what distinguishes "one bad
// attempt, a fresh one is already queued" from "this keeps failing and
// needs a human", per the spec's "repeated failure" requirement.
const REPEATED_FAILURE_THRESHOLD = 2;

function countTrailingFailures(jobsNewestFirst) {
  let n = 0;
  for (const job of jobsNewestFirst) {
    if (job.status !== 'failed') break;
    n++;
  }
  return n;
}

// Only the fields safe for a customer-facing UI — never the raw cause/stderr
// (lib/failure-classification.js's build() already keeps those out of
// `result.failure`; this is a second, deliberate narrowing on top, so this
// module can never accidentally forward a future field that isn't safe).
function publicFailure(failure) {
  if (!failure) return null;
  const { errorCode, failureClass, stage, recoverable, infrastructure, ref, attempts } = failure;
  return { errorCode, failureClass, stage, recoverable, infrastructure, ref, attempts };
}

// Pure — no I/O. `recentJobs` is newest-first, as getRecentDesignAgentJobs
// returns; `succeeded` is the caller's own already-computed "is there a
// verified, usable result RIGHT NOW" (e.g. componentTemplateVerification(...)
// .ok or contentWrapperAvailability(...).ok) — this module does not re-derive
// that, since design-drift.js already owns the single correct definition of
// "usable" (verified template, or a projectable design profile) and
// duplicating it here would be the exact kind of second state this spec asks
// to avoid.
// NOTE: this status is purely informational — see recommendation-gates.js and
// action-center.js's generateDraft, neither of which block on it any more. A
// site with no Design Context yet, or one whose last analysis run failed,
// still drafts and ships normally using the generator's own zero-config
// fallback; this is only ever surfaced so a human CAN look, never something
// that requires them to.
export function deriveDesignAgentStatus({ succeeded, recentJobs = [] } = {}) {
  if (succeeded) {
    return { state: DESIGN_AGENT_STATE.SUCCEEDED, detail: 'Design context is up to date.' };
  }

  const [latest, ...rest] = recentJobs;
  if (!latest) {
    return { state: DESIGN_AGENT_STATE.NEVER_ATTEMPTED, detail: 'Design context has not been derived yet — drafts use the default template until it is.' };
  }

  if (latest.status === 'queued' || latest.status === 'executing') {
    const running = latest.status === 'executing';
    return {
      state: running ? DESIGN_AGENT_STATE.RUNNING : DESIGN_AGENT_STATE.QUEUED,
      jobId: latest.id,
      detail: running
        ? 'Design context analysis is currently running.'
        : 'Design context analysis is queued and will run shortly.',
    };
  }

  if (latest.status === 'failed') {
    const attemptCount = countTrailingFailures(recentJobs); // includes `latest` itself
    const repeated = attemptCount >= REPEATED_FAILURE_THRESHOLD;
    const failure = publicFailure(latest.result?.failure);
    return {
      state: DESIGN_AGENT_STATE.FAILED,
      jobId: latest.id,
      failedAt: latest.finished_at,
      attemptCount,
      repeated,
      failure,
      // Deliberately no "blocked" / "needs intervention" language — a failed
      // analysis run never stops drafts from generating, so there is nothing
      // for a human to unblock. It's surfaced only as a diagnostic: this site
      // is currently drafting against the default fallback, not its real
      // design, until a run succeeds (retried automatically on the next
      // weekly rescan and any on-demand queue).
      detail: repeated
        ? `Design context analysis has failed ${attemptCount} times in a row (most recently job #${latest.id}` +
          `${failure?.errorCode ? `, ${failure.errorCode}` : ''}). Drafts continue to use the default fallback template in the meantime.`
        : `Design context analysis failed (job #${latest.id}) — drafts continue to use the default fallback template. It will retry automatically.`,
    };
  }

  // 'completed' but the caller's own `succeeded` check still says no — the
  // job ran, but persisting its result didn't leave a usable template/profile
  // (see worker.js: persistence failures are deliberately inside the same
  // try as the handler call, so a job that "completed" without a usable
  // artifact is a real, if rare, gap between execution_jobs.status and
  // whether the site actually gained anything). Reported as never_attempted
  // rather than a new state: from the Action Center's point of view, nothing
  // usable exists and nothing is in flight — the honest next step is the
  // same as if it had never run, and the next resolveOrCreateComponentTemplate
  // call will queue a fresh one exactly as it would for a first attempt.
  return { state: DESIGN_AGENT_STATE.NEVER_ATTEMPTED, detail: 'Design context analysis has not produced a usable result yet — drafts use the default template until it does.' };
}

// The I/O-performing wrapper. Scoped to ONE site's own job history — every
// query in store/execution-jobs.js filters by site_id, so this can never see
// (or be asked to derive a message from) another tenant's jobs; `site.id` is
// the only tenancy input this function takes.
export async function getDesignAgentStatus(site, {
  succeeded,
  jobKey = DESIGN_PROFILE_JOB_KEY,
  recentDesignAgentJobs = getRecentDesignAgentJobs,
  historyLimit = 5,
} = {}) {
  const recentJobs = await recentDesignAgentJobs(site.id, jobKey, historyLimit);
  return deriveDesignAgentStatus({ succeeded, recentJobs });
}
