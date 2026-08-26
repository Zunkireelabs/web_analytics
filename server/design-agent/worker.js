import { claimNextDesignAgentJob, appendJobLog, finishExecutionJob, reclaimStaleExecutingJobs } from '../store/execution-jobs.js';
import { createDesignAgentHandler } from './openhands-handler.js';
import { safeMessage } from '../lib/errors.js';
import { classifyFailure, shouldRetry } from '../lib/failure-classification.js';
import { getSiteById } from '../store/read.js';
import { persistDerivedComponentTemplates, persistDesignProfile } from '../implementers/lib/design-drift.js';
import { isDesignAgentQuietHours } from '../lib/design-agent-window.js';

const DEFAULT_POLL_INTERVAL_MS = 5000;

// How often the poll loop also checks for stale-'executing' jobs (see
// execution-jobs.js's reclaimStaleExecutingJobs), separate from
// pollIntervalMs — reclaiming is a cheap, mostly-no-op indexed UPDATE, but
// there is no reason to run it on every 5s job-claim tick. Every worker
// instance runs this independently and harmlessly: the UPDATE's own WHERE
// clause is the only guard needed, so redundant reclaim attempts across N
// replicas just race for the same rows (any that lose the race — see its
// SET status='queued' — no-op safely).
const DEFAULT_RECLAIM_INTERVAL_MS = 5 * 60 * 1000;

// Safety-net default for processOneJob below: if a caller ever invokes it
// (or createWorker) without an explicit handler, jobs fail loudly instead of
// silently no-opping. main()'s CLI entrypoint always passes the real
// createOpenHandsHandler() explicitly (Step 6C) — this only fires for a
// caller that forgot to. Production code (this file) never imports the
// test-only mock handler in test-support/ — that's wired in only by tests,
// via dependency injection.
async function notImplementedHandler() {
  throw new Error('Design Agent execution is not implemented yet — no handler was provided to processOneJob/createWorker.');
}

// Claims and fully settles at most one queued design_generate job: runs
// `handler(job)`, then transitions the job to completed/failed and records
// why. Returns null when the queue was empty (nothing to report), otherwise
// a summary of what happened — used directly by tests and by the poll loop
// below. `siteId` is optional and passed straight through to
// claimNextDesignAgentJob — production (main() below) never sets it, so the
// real worker keeps polling globally across every tenant; it exists for
// callers (worker.test.js's fixtures) that need to claim only their own
// site's jobs.
// Backoff before retry N (1-based): 2s, 4s. Deliberately short and finite —
// this is a bounded recovery from a blip, not a mechanism for waiting out a
// fault that needs a human. Injectable so tests exercise the real retry
// control flow without sleeping through it.
export const RETRY_BACKOFF_MS = [2000, 4000];
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs the agent (an external process) with bounded retries for TRANSIENT
// failures only. The classification decides — never the call site, and never
// a blanket "retry everything," which would burn model spend re-running work
// that cannot succeed and hide a broken deployment behind an attempt count.
//
// Only the handler call is wrapped. Everything after it (persisting the
// profile/templates) is deliberately OUTSIDE: a persist failure is an
// AGENT_LOGIC/validation fault, and re-running a whole repo analysis to
// retry a database write would be both wasteful and wrong.
//
// Every attempt is logged to the job as it happens, and the FIRST failure is
// preserved alongside the final one — so a job that failed after retries can
// still show what originally went wrong, not only the last symptom.
async function runWithRetry(job, handler, { maxAttempts, sleep, log }) {
  let firstFailure = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const outcome = await handler(job);
      if (attempt > 1) await log(job.id, `Attempt ${attempt} succeeded after ${attempt - 1} retry/retries.`);
      return { outcome, firstFailure };
    } catch (err) {
      const classification = classifyFailure({
        stage: err?.stage, err, exitCode: err?.exitCode ?? null, timedOut: err?.timedOut ?? false,
      });
      if (!firstFailure) firstFailure = classification;

      if (!shouldRetry(classification, attempt, maxAttempts)) {
        // Either non-retryable by class (deployment/repo/agent-logic/unsafe)
        // or the bounded attempt cap is reached. Both stop here — the caller
        // records the terminal failure.
        if (classification.recoverable) {
          await log(job.id, `Attempt ${attempt} failed [${classification.errorCode}] — retry limit (${maxAttempts}) reached, giving up.`);
        } else {
          await log(job.id, `Attempt ${attempt} failed [${classification.errorCode}] — ${classification.failureClass} is not retryable, not retrying.`);
        }
        err.firstFailure = firstFailure;
        err.attempts = attempt;
        throw err;
      }

      const waitMs = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
      await log(job.id, `Attempt ${attempt} failed [${classification.errorCode}] (transient) — retrying in ${waitMs}ms.`);
      await sleep(waitMs);
    }
  }
}

export async function processOneJob({
  handler = notImplementedHandler,
  siteId = null,
  getSiteByIdFn = getSiteById,
  persistTemplates = persistDerivedComponentTemplates,
  persistProfile = persistDesignProfile,
  maxAttempts = 3,
  sleep = defaultSleep,
  isQuietHours = isDesignAgentQuietHours,
} = {}) {
  // Deliberately checked BEFORE claiming, not after: claimNextDesignAgentJob
  // marks the row 'executing', so claiming during the quiet window and then
  // bailing would strand it there instead of leaving it 'queued' for the
  // next poll once the window closes. A job left queued costs nothing —
  // this worker polls every few seconds for the rest of its life.
  if (isQuietHours()) return null;

  const job = await claimNextDesignAgentJob(siteId);
  if (!job) return null;

  await appendJobLog(job.id, `Claimed by worker pid ${process.pid}`);
  try {
    const { outcome } = await runWithRetry(job, handler, { maxAttempts, sleep, log: appendJobLog });

    // A component-templates job's whole point is to leave a VERIFIED template
    // on the site row. Writing the derived markup only onto execution_jobs.result
    // (below) does not do that: every reader of that column was deleted with the
    // human-confirm workflow (f7156ef), so this job's real output had no consumer
    // at all — the queued re-derivation design-drift.js enqueues for an unverified
    // template ran, succeeded, and was discarded, leaving the gate downstream to
    // reject the same template forever. This is the consumer.
    //
    // Deliberately INSIDE the try, before the status transition: if persisting
    // fails, this job is a failure — the site is no better off than before it ran
    // — and the next draft attempt should queue a fresh derivation rather than
    // trust a 'completed' row that changed nothing.
    // A design-profile job persists the profile AND projects every
    // design-sensitive template from it in one pass — one analysis, the
    // site's whole design-sensitive surface. Same "inside the try, before the
    // status transition" placement as component-templates below: if
    // persisting fails, the job is a failure and the next attempt re-queues.
    if (job.params?.mode === 'design-profile' && outcome?.designProfile) {
      const site = await getSiteByIdFn(job.site_id);
      if (!site) throw new Error(`site ${job.site_id} no longer exists — cannot save the derived design profile`);
      const saved = await persistProfile(site, outcome.designProfile, { jobId: job.id });
      if (!saved.ok) throw new Error(`Design Agent returned an unusable design profile — ${saved.reason}`);
      await appendJobLog(job.id, `Derived design profile; projected ${Object.keys(saved.projected).length} component template(s).`);
    }

    if (job.params?.mode === 'component-templates' && outcome?.componentTemplates) {
      const site = await getSiteByIdFn(job.site_id);
      if (!site) throw new Error(`site ${job.site_id} no longer exists — cannot save derived component templates`);
      const persisted = await persistTemplates(site, outcome.componentTemplates, { jobId: job.id });
      const savedKeys = Object.keys(persisted.saved || {});
      if (!savedKeys.length) {
        const why = persisted.rejected?.map((r) => `${r.actionType}: ${r.error || r.reason}`).join('; ') || 'no usable template in the result';
        throw new Error(`Design Agent returned no saveable component template — ${why}`);
      }
      await appendJobLog(job.id, `Verified and saved component template(s): ${savedKeys.join(', ')}`);
    }

    await appendJobLog(job.id, 'Job completed');
    // outcome is the handler's own return value (e.g. openhands-handler.js's
    // { jobId, detail, componentTemplates } for a component-templates job) —
    // persisted on the job row (090) so a caller that isn't the process that
    // ran it (a later HTTP request polling job status) can retrieve it.
    await finishExecutionJob(job.id, { status: 'completed', result: outcome || null });
    return { jobId: job.id, status: 'completed', result: outcome };
  } catch (err) {
    // A UserFacingError is developer-authored text with no interpolated
    // exception detail (see lib/errors.js) — the one kind of message this
    // codebase already trusts to reach a customer. Preferring it here is what
    // lets a job say WHICH stage failed instead of only "failed unexpectedly".
    //
    // That distinction is not cosmetic. Job 2696 on site 1 ran 43.8s and then
    // failed with the generic text, and because the real cause exists only in
    // this container's stdout, it could not be diagnosed from the database at
    // all — days later it was still unknown whether the repo checkout, Docker,
    // or the model call had broken. The internal log and its correlation id are
    // still written either way; this only decides how much the job row itself
    // can honestly say.
    const { message, id } = safeMessage('design-agent.worker.processOneJob', err, 'Design Agent job failed unexpectedly.');

    // Classify BEFORE writing anything, so the job row records what kind of
    // failure this was and who can act on it — not just that it failed. The
    // `stage` an error carries (set by the handler at the boundary that
    // threw) is authoritative; classifyFailure never guesses one from
    // message text. See lib/failure-classification.js for why an
    // unrecognized failure is deliberately classed as ours, not transient.
    const classification = classifyFailure({
      stage: err?.stage,
      err,
      exitCode: err?.exitCode ?? null,
      timedOut: err?.timedOut ?? false,
    });

    const attempts = err?.attempts ?? 1;
    // The FIRST failure is kept when it differs from the last: a job that
    // timed out, retried, then failed validation should show both, or the
    // original trigger is lost behind whatever the final symptom happened to
    // be. Identical classifications are not duplicated.
    const firstFailure = err?.firstFailure && err.firstFailure.errorCode !== classification.errorCode
      ? err.firstFailure
      : null;

    const detail = err?.userFacing ? err.message : message;
    await appendJobLog(job.id, `Job failed [${classification.errorCode}] at stage '${classification.stage}': ${detail} `
      + `(class: ${classification.failureClass}, recoverable: ${classification.recoverable}, attempts: ${attempts}, ref: ${id})`);
    // Persisted on the job row so a reader who is not this process — the
    // Action Center, a later HTTP poll — can tell an infrastructure blocker
    // apart from an agent fault without shelling into this container, which
    // is exactly what was impossible before.
    await finishExecutionJob(job.id, {
      status: 'failed',
      result: { failure: { ...classification, ref: id, attempts, ...(firstFailure ? { firstFailure } : {}) } },
    });
    return { jobId: job.id, status: 'failed', error: err.message, failure: classification, attempts };
  }
}

// Standalone DB-poll worker. Self-reschedules via setTimeout rather than
// setInterval specifically so a poll can never overlap the next one — the
// next timer is only armed once the current poll (claim attempt, plus
// whatever job it claimed) has fully settled, no matter how long that took.
// `onPoll(result)` is optional, mainly for tests to observe each cycle
// without polling worker internals.
export function createWorker({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, reclaimIntervalMs = DEFAULT_RECLAIM_INTERVAL_MS,
  handler, onPoll, onReclaim, siteId = null, reclaim = reclaimStaleExecutingJobs,
} = {}) {
  let timer = null;
  let started = false;
  let stopped = false;
  let currentPoll = null;
  let lastReclaimAt = 0; // 0 so the very first tick always reclaims — a fresh worker starting up is exactly when a predecessor's stranded job most needs picking up

  async function maybeReclaim() {
    if (Date.now() - lastReclaimAt < reclaimIntervalMs) return;
    lastReclaimAt = Date.now();
    try {
      const reclaimed = await reclaim();
      if (reclaimed.length) console.warn(`[design-agent-worker] reclaimed ${reclaimed.length} stale 'executing' job(s) back to 'queued': ${reclaimed.map((j) => `#${j.id}`).join(', ')}`);
      if (onReclaim) onReclaim(reclaimed);
    } catch (err) {
      console.error('[design-agent-worker] stale-job reclaim failed:', err.message);
    }
  }

  async function pollLoop() {
    await maybeReclaim();
    currentPoll = processOneJob({ handler, siteId })
      .then((result) => { if (onPoll) onPoll(result); })
      .catch((err) => console.error('[design-agent-worker] poll error:', err.message))
      .finally(() => { currentPoll = null; });
    await currentPoll;
    if (!stopped) timer = setTimeout(pollLoop, pollIntervalMs);
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      pollLoop();
    },
    // Stops scheduling further polls and waits for any in-flight poll (claim
    // + handler + status transition) to fully settle before resolving, so a
    // claimed job is never left stranded in 'executing' on shutdown.
    async stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (currentPoll) await currentPoll;
      started = false;
    },
    isPolling: () => currentPoll !== null,
  };
}

function installShutdownHandlers(worker) {
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[design-agent-worker] received ${signal}, finishing any in-flight job then stopping…`);
    await worker.stop();
    console.log('[design-agent-worker] stopped.');
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function main() {
  const pollIntervalMs = Number(process.env.DESIGN_AGENT_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);
  const worker = createWorker({ pollIntervalMs, handler: createDesignAgentHandler() });
  console.log(`[design-agent-worker] starting — polling every ${pollIntervalMs}ms for kind='design_generate' queued jobs`);
  installShutdownHandlers(worker);
  worker.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
