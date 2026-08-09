import { claimNextDesignAgentJob, appendJobLog, finishExecutionJob } from '../store/execution-jobs.js';
import { createDesignAgentHandler } from './openhands-handler.js';

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
// below.
export async function processOneJob({ handler = notImplementedHandler } = {}) {
  const job = await claimNextDesignAgentJob();
  if (!job) return null;

  await appendJobLog(job.id, `Claimed by worker pid ${process.pid}`);
  try {
    const outcome = await handler(job);
    await appendJobLog(job.id, 'Job completed');
    // outcome is the handler's own return value (e.g. openhands-handler.js's
    // { jobId, detail, componentTemplates } for a component-templates job) —
    // persisted on the job row (090) so a caller that isn't the process that
    // ran it (a later HTTP request polling job status) can retrieve it.
    await finishExecutionJob(job.id, { status: 'completed', result: outcome || null });
    return { jobId: job.id, status: 'completed', result: outcome };
  } catch (err) {
    await appendJobLog(job.id, `Job failed: ${err.message}`);
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
export function createWorker({ pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, handler, onPoll } = {}) {
  let timer = null;
  let started = false;
  let stopped = false;
  let currentPoll = null;

  async function pollLoop() {
    currentPoll = processOneJob({ handler })
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
