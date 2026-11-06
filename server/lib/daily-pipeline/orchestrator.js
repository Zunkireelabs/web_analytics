import { rotateForToday, runSiteWithDeadline } from '../site-run.js';
import { STAGES, REQUIRED_STAGES, pastDeadline } from './config.js';

// The one daily orchestrator. It walks every enabled project through the stages, one project at a time, each in its own
// isolated pass with its own time budget, and records a checkpoint per (project, day, stage) so a restart, a retry or a second
// process can never redo finished work or ship anything twice.
//
// It owns ORDER, DEADLINES, RETRIES and CHECKPOINTS. It owns no business logic: each stage is a function handed in (see
// stages.js), which calls the existing agents, generators and gates. That is what keeps this testable with no database and
// is why nothing existing is reimplemented here.
//
// WHAT A STAGE CAN RETURN
//   undefined / an object   done (the object is stored as the stage's details)
//   { skip: 'reason' }      not applicable today (stored as skipped; never retried)
//   throws                  failed (retried on a later pass until maxAttempts)
//
// A stage with `notBefore` is left alone until that moment (the Design Agent's live checks wait for its quiet hours to end), and a
// stage with `ready()` until that returns true (the analyst stage waits for the Data Analyst's completion marker): no row is
// written, so a later pass in the same day simply takes it. At the deadline either kind is recorded as deferred, with its reason.
//
// ISOLATION. A failure, a timeout or an exhausted budget in one project never touches another. Only the project's own rows and
// its own site object are handed to its stages.
export async function runDailyPipeline({
  sites,
  stages,
  store,
  runDate,
  deadlineAt = null,
  config,
  now = () => Date.now(),
  runWithDeadline = runSiteWithDeadline,
  rotate = rotateForToday,
  log = (...a) => console.log(...a),
  logError = (...a) => console.error(...a),
}) {
  const summary = { runDate, sites: [], deadlineReached: false };
  const ordered = rotate(sites);

  for (const site of ordered) {
    if (pastDeadline(deadlineAt, now())) {
      summary.deadlineReached = true;
      log(`[pipeline] ${runDate}: deadline reached before project ${site.id} "${site.name}" started — its work stays queued for the next cycle.`);
      break;
    }

    const result = { siteId: site.id, name: site.name, done: [], failed: [], deferred: [], skipped: [], waiting: [] };
    summary.sites.push(result);
    let current = null; // the stage in flight, so a hard timeout can be recorded against it

    // The soft limit is the project's budget, cut short by the daily deadline; the hard stop is that plus the grace period.
    const softMs = deadlineAt != null ? Math.min(config.perSiteBudgetMs, Math.max(1, deadlineAt - now())) : config.perSiteBudgetMs;
    const run = await runWithDeadline(site, async ({ isAborted }) => {
      for (const stage of stages) {
        if (isAborted()) return;
        if (pastDeadline(deadlineAt, now())) {
          // A stage that never became ready (or never reached its time) by the deadline is recorded as deferred, with its reason,
          // so a day the Data Analyst did not confirm its findings is visible instead of silently empty.
          const reason = stage.ready ? `${stage.notReadyReason || 'not ready'} by the daily deadline` : 'the daily deadline passed before this stage started';
          await store.deferStage(site.id, runDate, stage.name, reason);
          result.deferred.push(stage.name);
          continue;
        }
        if (stage.notBefore != null && now() < stage.notBefore) { result.waiting.push(stage.name); continue; }
        // A readiness gate (e.g. "the Data Analyst confirmed today's findings"). Not ready means wait: no row, no attempt used,
        // nothing blocked; a later pass (the 07:45 resume, the hourly guard) checks again.
        if (stage.ready) {
          let ready = false;
          try { ready = await stage.ready({ site, runDate, now }); } catch { ready = false; }
          if (!ready) { result.waiting.push(stage.name); continue; }
        }

        const begun = await store.beginStage(site.id, runDate, stage.name, { maxAttempts: config.maxAttempts });
        if (!begun.start) {
          // Already finished, running elsewhere, or out of attempts: nothing to do, and an earlier failure that used up its
          // attempts still stops a required stage's dependants.
          if (begun.status === 'failed' && REQUIRED_STAGES.includes(stage.name)) { result.failed.push(stage.name); return; }
          continue;
        }

        current = stage.name;
        try {
          const out = await stage.run({ site, runDate, deadlineAt, isAborted, attempt: begun.attempt, now });
          if (out && out.skip) {
            await store.skipStage(site.id, runDate, stage.name, out.skip);
            result.skipped.push(stage.name);
          } else {
            await store.finishStage(site.id, runDate, stage.name, { details: out || {} });
            result.done.push(stage.name);
          }
        } catch (err) {
          await store.failStage(site.id, runDate, stage.name, err).catch(() => {});
          result.failed.push(stage.name);
          logError(`[pipeline] ${runDate} project ${site.id} "${site.name}": stage ${stage.name} failed (attempt ${begun.attempt}): ${err.message}`);
          if (REQUIRED_STAGES.includes(stage.name)) return; // its dependants need what it was meant to produce
        } finally {
          current = null;
        }
      }
    }, { timeoutMs: softMs, graceMs: config.graceMs, label: 'daily pipeline' });

    if (run.timedOut && current) {
      // The pass stopped waiting. The row is left for the next pass to retake instead of staying 'running' forever.
      await store.failStage(site.id, runDate, current, 'timed out: the project used up its time budget').catch(() => {});
      result.failed.push(current);
    } else if (!run.ok && !run.timedOut) {
      logError(`[pipeline] ${runDate} project ${site.id} "${site.name}" failed:`, run.error?.message);
    }
  }
  return summary;
}

export { STAGES };
