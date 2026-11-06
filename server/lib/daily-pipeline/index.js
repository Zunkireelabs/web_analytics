import { withJobLock, jobKeyFor } from '../job-lock.js';
import { pipelineConfig, runDateIn, todayAt } from './config.js';
import { runDailyPipeline } from './orchestrator.js';
import { defaultStages } from './stages.js';
import * as store from '../../store/pipeline-runs.js';

// One pass of the unified daily pipeline. Called by the 05:30 start, the 07:45 resume and the hourly resume guard; because every
// stage is checkpointed per project and day, calling it again only ever does what is left.
//
// Held under ONE lease for the whole pass (key 'daily-pipeline'), so two processes (a laptop left running, a second worker)
// can never run it at once; the loser logs and skips.
export async function runPipelinePass({ now = new Date(), env = process.env, deps = {} } = {}) {
  const config = pipelineConfig(env);
  if (!config.enabled) return { skipped: 'disabled' };

  const tz = config.timezone;
  const runDate = runDateIn(tz, now);
  const deadlineAt = todayAt(config.prepDeadline, tz, now);
  if (deadlineAt != null && now.getTime() >= deadlineAt + config.graceMs) return { skipped: 'after-deadline', runDate };

  const stages = deps.stages || defaultStages({
    config,
    startOfDayMs: todayAt('00:00', tz, now),
    analystWaitUntilMs: todayAt(config.analystWaitUntil, tz, now),
    liveDesignFromMs: todayAt(config.liveDesignFrom, tz, now),
  });
  const { listConnectedSites } = deps.job || await import('../../job.js');

  const { ran, result } = await withJobLock(jobKeyFor('daily-pipeline', 'all-sites'), async () => {
    await store.releaseStaleStages().catch((err) => console.error('[pipeline] could not release stale stages:', err.message));
    const sites = await listConnectedSites();
    return runDailyPipeline({ sites, stages, store, runDate, deadlineAt, config });
  });
  if (!ran) return { skipped: 'locked', runDate };
  return { ran: true, runDate, ...result };
}
