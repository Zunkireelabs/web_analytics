import { claimNextDesignAgentJob, appendJobLog, finishExecutionJob } from '../store/execution-jobs.js';
import { createDesignAgentHandler } from './openhands-handler.js';
import { safeMessage } from '../lib/errors.js';
import { getSiteById } from '../store/read.js';
import { persistDerivedComponentTemplates, persistDesignProfile } from '../implementers/lib/design-drift.js';

const DEFAULT_POLL_INTERVAL_MS = 5000;

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
export async function processOneJob({
  handler = notImplementedHandler,
  siteId = null,
  getSiteByIdFn = getSiteById,
  persistTemplates = persistDerivedComponentTemplates,
  persistProfile = persistDesignProfile,
} = {}) {
  const job = await claimNextDesignAgentJob(siteId);
  if (!job) return null;

  await appendJobLog(job.id, `Claimed by worker pid ${process.pid}`);
  try {
    const outcome = await handler(job);

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
    await appendJobLog(job.id, `Job failed: ${err?.userFacing ? err.message : message} (ref: ${id})`);
    await finishExecutionJob(job.id, { status: 'failed' });
    return { jobId: job.id, status: 'failed', error: err.message };
  }
}

// Standalone DB-poll worker. Self-reschedules via setTimeout rather than
// setInterval specifically so a poll can never overlap the next one — the
// next timer is only armed once the current poll (claim attempt, plus
// whatever job it claimed) has fully settled, no matter how long that took.
// `onPoll(result)` is optional, mainly for tests to observe each cycle
// without polling worker internals.
export function createWorker({ pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, handler, onPoll, siteId = null } = {}) {
  let timer = null;
  let started = false;
  let stopped = false;
  let currentPoll = null;

  async function pollLoop() {
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
