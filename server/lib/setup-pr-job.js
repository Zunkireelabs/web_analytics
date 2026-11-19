import { isActiveSite } from './ship-window.js';

// The job that opens the setup PR (implementers/lib/setup-pr.js) for projects whose time has come (store/setup-pr.js).
//
// WHEN: a project is due once its onboarding audit finished and an hour passed (bulk-audit.js schedules it), or when staff schedule
// it by hand (scripts/schedule-setup-pr.js, the way the first three existing projects were rolled out one at a time).
// WHAT ELSE IS NEEDED: the baseline is done, GitHub is connected, Auto-fixes is on, the project is active. NOT needed: a design profile
// (markers are empty comments and never read it) and OpenAI (nothing here uses a model), so neither a failed design capture nor a spend
// cap can hold this PR.
//
// During the wait the platform learns the project: just before planning, the repo discovery runs again (technology, routes, the page to
// file mapping), so the plan is made from what is known now and not from what was known when the repo was connected.
//
// One project per pass. The pass runs every ten minutes, so a rollout of several projects is naturally spread out, and a slow GitHub
// call for one project never holds up another.

export const RETRY_AFTER_MS = 30 * 60 * 1000;

// THE FIRST ROLLOUT, in this order (owner, 2026-11-19): MOBILISE, then SuperRank, then Zennly. Each project is scheduled for "now" only
// when every project before it is done, so they open one after the other and a problem with the first stops the rest instead of
// repeating on all three. Projects whose setup PR is done are skipped; a project that is not ready or has used up its attempts holds the
// queue (the reason is on its row: setup_pr_last_error). New projects are not in this list: they are scheduled an hour after their
// onboarding audit (agents/lib/bulk-audit.js). SETUP_PR_ROLLOUT overrides the list (comma-separated ids); "off" or empty switches it off.
export const DEFAULT_ROLLOUT = [8874, 8871, 8872];
export function rolloutIds(env = process.env) {
  const v = env.SETUP_PR_ROLLOUT;
  if (v === undefined) return DEFAULT_ROLLOUT;
  if (!v.trim() || v.trim().toLowerCase() === 'off') return [];
  return v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

// Schedules the first project in the list that is not done and not already scheduled. Looks at one project and stops: the next one is
// only looked at once this one is done.
export async function advanceRollout({ now = new Date(), deps = {}, log = console } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  for (const id of d.rolloutIds()) {
    const state = await d.getState(id);
    if (!state) { log.log?.(`[setup-pr] rollout: site ${id} not found, skipping.`); continue; }
    if (state.setup_pr_done_at) continue;                    // done: on to the next
    if (!state.setup_pr_due_at) {
      await d.schedule(id, now);
      log.log?.(`[setup-pr] rollout: site ${id} scheduled now.`);
      return { scheduled: id };
    }
    return { waitingOn: id };                                  // scheduled or running: the next waits its turn
  }
  return { finished: true };
}

const DEFAULT_DEPS = {
  enabled: () => process.env.SETUP_PR_ENABLED !== 'false',
  rolloutIds: () => rolloutIds(),
  async getState(id) { return (await import('../store/setup-pr.js')).getSetupPrState(id); },
  async schedule(id, at) { return (await import('../store/setup-pr.js')).scheduleSetupPr(id, at); },
  async listDueSiteIds(now, limit) { return (await import('../store/setup-pr.js')).listDueSetupPrSiteIds(now, limit); },
  async getSite(id) { return (await import('../store/read.js')).getSiteById(id); },
  async recordDone(id, result, now) { return (await import('../store/setup-pr.js')).recordSetupPrDone(id, result, now); },
  async defer(id, reason, retryAt) { return (await import('../store/setup-pr.js')).deferSetupPr(id, reason, retryAt); },
  async recordFailure(id, error, retryAt) { return (await import('../store/setup-pr.js')).recordSetupPrFailure(id, error, retryAt); },
  async withLock(siteId, fn) {
    const { withJobLock, jobKeyFor } = await import('./job-lock.js');
    return withJobLock(jobKeyFor('setup-pr', siteId), fn);
  },
  // The whole readiness pass (readiness/run.js): learn the stack, complete the page list, map every page, plan the markers, the completeness gate, the design
  // capture. apply: the inferred mapping is saved (read back, restored on any difference) and the design capture is queued if the project has none.
  async readiness(site) {
    const { runSiteReadiness, summarizeReadiness } = await import('../readiness/run.js');
    const r = await runSiteReadiness(site, { apply: true });
    return { ...r, summary: summarizeReadiness(r) };
  },
  async saveReadiness(id, summary) { return (await import('../store/readiness.js')).saveReadinessResult(id, summary); },
  async open(site, plan, opts) { return (await import('../implementers/lib/setup-pr.js')).openSetupPr(site, plan, opts); },
};

// Why this project is not ready yet, or null when it is. Pure.
export function notReadyReason(site) {
  if (!site) return 'project not found';
  if (!isActiveSite(site)) return 'project is not active';
  if (!site.repo_owner || !site.repo_name) return 'no GitHub repository connected';
  if (!site.auto_remediation_enabled) return 'Auto-fixes is off';
  if (!site.onboarded_at) return 'the baseline is not done';
  return null;
}

const summarize = (plan, extra = {}) => ({
  gaps: plan.gaps ? plan.gaps.length : null,
  files: plan.files.length,
  markers: plan.files.reduce((n, f) => n + f.added.length, 0),
  coverage: plan.coverage || null,
  unresolved: plan.unresolved.length,
  skipped: plan.skipped.length,
  truncated: plan.truncated,
  ...extra,
});

// One project. Never throws: a failure is recorded and retried later.
export async function runSetupPrForSite(siteId, { now = new Date(), deps = {}, log = console } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const locked = await d.withLock(siteId, async () => {
    let site = await d.getSite(siteId);
    const notReady = notReadyReason(site);
    if (notReady) {
      // Not an error to retry blindly: a project that is not ready is looked at again in an hour, and the reason is kept.
      await d.defer(siteId, `not ready: ${notReady}`, new Date(now.getTime() + 60 * 60 * 1000));
      log.log?.(`[setup-pr] site ${siteId}: not ready (${notReady}); will look again in an hour.`);
      return { siteId, status: 'not-ready', reason: notReady };
    }
    try {
      // The whole readiness pass first: the platform learns the project (stack, every page, every template file, the layout's own keys), saves what it
      // inferred and read back, queues the design capture if there is none, and plans the markers from that. A failure is recorded and retried.
      const ready = await d.readiness(site);
      if (ready.reason) {
        await d.defer(siteId, `not ready: ${ready.reason}`, new Date(now.getTime() + 60 * 60 * 1000));
        return { siteId, status: 'not-ready', reason: ready.reason };
      }
      const stack = ready.stack || null;
      const plan = ready.plan;
      await d.saveReadiness(siteId, ready.summary).catch((err) => log.error?.(`[setup-pr] site ${siteId}: could not store the readiness result:`, err?.message));
      if (!plan.files.length) {
        const result = summarize(plan, { status: 'nothing-to-add' });
        await d.recordDone(siteId, result, now);
        log.log?.(`[setup-pr] site ${siteId}: nothing to add (${plan.alreadyComplete} template(s) already complete, ${plan.unresolved.length} marker(s) with no safe place).`);
        return { siteId, status: 'nothing-to-add', result };
      }
      const opened = await d.open(site, plan, { stack });
      const result = summarize(plan, { status: opened.reason || 'opened', prUrl: opened.prUrl || null, prNumber: opened.prNumber || null, branch: opened.branch || null });
      await d.recordDone(siteId, result, now);
      log.log?.(`[setup-pr] site ${siteId}: ${opened.opened ? 'opened' : opened.reason} ${opened.prUrl || ''} (${plan.files.length} file(s)).`);
      return { siteId, status: opened.opened ? 'opened' : opened.reason, result };
    } catch (err) {
      await d.recordFailure(siteId, err?.message || 'failed', new Date(now.getTime() + RETRY_AFTER_MS)).catch(() => {});
      log.error?.(`[setup-pr] site ${siteId} failed, will retry:`, err?.message);
      return { siteId, status: 'failed', error: err?.message };
    }
  });
  if (!locked.ran) return { siteId, status: 'locked' };
  return locked.result;
}

// The cron pass: the oldest due project, one at a time.
export async function runSetupPrsDue({ now = new Date(), limit = 1, deps = {}, log = console } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  if (!d.enabled()) return { ran: 0, disabled: true, results: [] };
  await advanceRollout({ now, deps, log }).catch((err) => log.error?.('[setup-pr] rollout step failed:', err?.message));
  const ids = await d.listDueSiteIds(now, limit);
  const results = [];
  for (const id of ids) results.push(await runSetupPrForSite(id, { now, deps, log }));
  return { ran: results.length, results };
}
