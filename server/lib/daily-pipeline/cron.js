import nodeCron from 'node-cron';
import { pipelineConfig, minutesOf, minutesIn } from './config.js';

// Cron wiring for the unified daily pipeline. EVERYTHING here is inert unless DAILY_PIPELINE_ENABLED=true, and when it is on the
// legacy morning lanes it replaces stand down (cron.js asks pipelineOwnsMorning()).
//
// All times are Asia/Kathmandu (node-cron's per-schedule timezone); the process TZ is untouched.
//   05:30  start: every project through research -> design-baseline -> analyst (waits for the Python findings_complete marker)
//          -> repair -> generate
//   07:45  resume: live design checks, then prepare (generation + validation, nothing pushed)
//   08:20, 09:20, 10:20  resume guard (a pass only does what is left; nothing starts after the 10:50 deadline)
//   11:00  ONE consolidated ship: prepared work only, one PR per project, never merged; then the shared repair queues drain
//          (drain-only: nothing new is generated at ship time); then the learning update.

// The legacy morning lanes stand down ONLY when the pipeline is on AND its schedule is valid, so a bad PIPELINE_* setting can never
// leave the day with neither the pipeline nor the legacy run.
export function pipelineOwnsMorning(env = process.env, cron = nodeCron) {
  const config = pipelineConfig(env);
  return config.enabled && schedulesAreValid(config, cron);
}

const hm = (hhmm) => { const m = minutesOf(hhmm); return m == null ? null : { h: Math.floor(m / 60), m: m % 60 }; };

function schedulesAreValid(config, cron) {
  const ex = pipelineCronExpressions(config);
  return Boolean(ex && cron.validate(ex.start) && cron.validate(ex.resume) && cron.validate(ex.ship) && (!ex.guard || cron.validate(ex.guard)));
}

export function pipelineCronExpressions(config = pipelineConfig()) {
  const live = hm(config.liveDesignFrom); const deadline = hm(config.prepDeadline); const ship = hm(config.shipAt);
  if (!live || !deadline || !ship) return null;
  const guardFrom = live.h + 1; const guardTo = deadline.h;
  return {
    start: config.startCron,
    resume: `${live.m} ${live.h} * * *`,
    guard: guardFrom <= guardTo ? `20 ${guardFrom}-${guardTo} * * *` : null,
    ship: `${ship.m} ${ship.h} * * *`,
  };
}

// What the 11:00 job does. Injected so it is testable; the real versions are bound in schedulePipelineCron.
export async function runShipJob({ config, now = new Date(), shipPrepared, drainSharedQueues, learningUpdate, log = console }) {
  const shipped = await shipPrepared();
  if (shipped.skipped) { log.log(`[pipeline] 11:00 ship run did not run: ${shipped.skipped}`); return { shipped }; }
  // The shared repair queues (content/template repair, learned-repair) keep their existing drain: same lanes, same budget, same
  // PR rules, but drain-only, so it cannot generate anything that was not prepared.
  let drained = null;
  try { drained = await drainSharedQueues(); } catch (err) { log.error('[pipeline] shared-queue drain error:', err.message); }
  let learning = null;
  try { learning = await learningUpdate(); } catch (err) { log.error('[pipeline] learning update error:', err.message); }
  return { shipped, drained, learning };
}

export function schedulePipelineCron({ cron, locked, config = pipelineConfig(), deps = {}, log = console }) {
  if (!config.enabled) { log.log('[cron] daily pipeline: off (DAILY_PIPELINE_ENABLED is not "true") — legacy schedule unchanged'); return { scheduled: false }; }
  const ex = pipelineCronExpressions(config);
  if (!schedulesAreValid(config, cron)) {
    log.error('[cron] daily pipeline: invalid schedule settings — the pipeline is NOT scheduled and the LEGACY morning lanes keep running; fix the PIPELINE_* settings');
    return { scheduled: false, invalid: true };
  }
  const tz = config.timezone;
  const pass = async (label) => {
    try { const r = await (deps.runPipelinePass || (await import('./index.js')).runPipelinePass)(); log.log(`[pipeline] ${label}: ${JSON.stringify(r.skipped ? { skipped: r.skipped } : { ran: true, runDate: r.runDate })}`); }
    catch (err) { log.error(`[pipeline] ${label} error:`, err.message); }
  };
  cron.schedule(ex.start, async () => {
    // Weekly-if-due page discovery used to open the morning run; it stays first, so the pages it finds are the ones worked today.
    try {
      const { runSiteDiscoveryIfDueForAllSites } = deps.job || await import('../../job.js');
      const found = await runSiteDiscoveryIfDueForAllSites({ windowEndsAt: Date.now() + 15 * 60 * 1000 });
      if (found.filter(Boolean).length) log.log(`[pipeline] site discovery before the run: ${found.filter(Boolean).length} site(s)`);
    } catch (err) { log.error('[pipeline] site discovery failed:', err.message); }
    await pass('start');
  }, { timezone: tz });
  cron.schedule(ex.resume, () => pass('live-design resume'), { timezone: tz });
  if (ex.guard) cron.schedule(ex.guard, () => pass('resume guard'), { timezone: tz });
  cron.schedule(ex.ship, () => locked('daily-pipeline-ship', async () => {
    const job = deps.job || await import('../../job.js');
    const { shipPreparedForAllSites } = await import('./ship.js');
    const queue = await import('../../store/shipping-queue.js');
    const drafts = await import('../../store/drafts.js');
    const action = await import('../../routes/action-center.js');
    const ghops = await import('../../implementers/lib/github-ops.js');
    const { runDailyLearningUpdate } = deps.learning || await import('../learning-cycle.js');
    const shipDeps = deps.shipDeps || {
      listByState: queue.listByState, claimForShipping: queue.claimForShipping, markShipped: queue.markShipped, releaseItem: queue.releaseItem,
      beginBatchPush: ghops.beginBatchPush, batchBranchName: ghops.batchBranchName,
      approveAndPublishDraftUnattended: action.approveAndPublishDraftUnattended, finalizeBatchPr: action.finalizeBatchPr,
      abandonDraft: (siteId, draftId, reason) => drafts.markDraftAbandoned(siteId, draftId, reason, 'daily-pipeline'),
    };
    const r = await runShipJob({
      config,
      shipPrepared: async () => shipPreparedForAllSites({ sites: await job.listConnectedSites(), deps: shipDeps, config, now: new Date(), localMinutes: (n) => minutesIn(tz, n) }),
      drainSharedQueues: () => job.runAutoRemediationForAllSites({ windowEndsAt: Date.now() + 60 * 60 * 1000, drainOnly: true }),
      learningUpdate: () => runDailyLearningUpdate(),
      log,
    });
    log.log(`[pipeline] 11:00 ship run finished: ${JSON.stringify({ shipped: r.shipped?.skipped ?? (r.shipped?.results || []).map((x) => ({ site: x.siteId, shipped: x.shipped, pr: x.pr?.number ?? null })) })}`);
  }), { timezone: tz });
  log.log(`[cron] daily pipeline scheduled (${tz}): start "${ex.start}", resume "${ex.resume}"${ex.guard ? `, guard "${ex.guard}"` : ''}, ship "${ex.ship}" — legacy morning lanes stand down`);
  return { scheduled: true, ...ex };
}
