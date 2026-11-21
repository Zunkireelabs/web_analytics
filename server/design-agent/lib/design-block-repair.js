// A design gate that only blocks makes a person the repair loop. When the SAME
// site is held again and again for a gap the Design Agent can fill (the
// completeness gate marks these `repairable`), the right response is to send
// the agent back to look at the live site again — not to wait.
//
// This only QUEUES the existing design-profile derivation job; it adds no new
// repair mechanism. It is deliberately slow to fire: a few repeated repairable
// blocks inside a week, nothing already queued, and a cooldown since the last
// derivation, so a persistent gap cannot turn into a job per draft.

export const REQUEUE_AFTER_BLOCKS = 2;
export const REQUEUE_WINDOW_DAYS = 7;
export const REQUEUE_COOLDOWN_DAYS = 3;

async function defaultDeps() {
  const { query } = await import('../../db.js');
  const jobs = await import('../../store/execution-jobs.js');
  const drift = await import('../../implementers/lib/design-drift.js');
  return {
    countBlocks: async (siteId, days) => {
      const { rows } = await query(
        `SELECT count(*)::int AS n FROM design_gate_decisions
          WHERE site_id = $1 AND gate = 'completeness' AND blocked
            AND detail->>'repairable' = 'true'
            AND created_at > now() - ($2::int * interval '1 day')`,
        [siteId, days],
      );
      return rows[0]?.n || 0;
    },
    findLatestJob: (siteId) => jobs.getLatestDesignAgentJob(siteId, jobs.DESIGN_PROFILE_JOB_KEY),
    findQueued: (siteId) => jobs.getQueuedComponentTemplateJob(siteId, jobs.DESIGN_PROFILE_JOB_KEY),
    enqueue: (siteId, opts) => jobs.createDesignProfileJob(siteId, opts),
    resolvePageUrl: drift.sitePageUrl,
  };
}

async function requeue(site, deps, now, { requireRepeat }) {
  try {
    if (!site?.id || !site.repo_owner || !site.repo_name) return { queued: false, reason: 'no-repo' };
    const d = { ...(await defaultDeps()), ...deps };
    if (requireRepeat) {
      const blocks = await d.countBlocks(site.id, REQUEUE_WINDOW_DAYS);
      if (blocks < REQUEUE_AFTER_BLOCKS) return { queued: false, reason: 'not-repeated' };
    }
    if (await d.findQueued(site.id)) return { queued: false, reason: 'already-queued' };
    const latest = await d.findLatestJob(site.id);
    const last = latest?.created_at ? new Date(latest.created_at).getTime() : 0;
    if (last && now.getTime() - last < REQUEUE_COOLDOWN_DAYS * 86400000) return { queued: false, reason: 'cooldown' };
    const pageUrl = d.resolvePageUrl(site);
    if (!pageUrl) return { queued: false, reason: 'no-page-url' };
    await d.enqueue(site.id, { requestedBy: null, pageUrl });
    return { queued: true, reason: requireRepeat ? 'repeated-repairable-blocks' : 'diagnosed-design-capture-gap' };
  } catch (err) {
    console.warn(`[design-block-repair] could not re-queue design profile for site ${site?.id}: ${err.message}`);
    return { queued: false, reason: 'error' };
  }
}

/** @returns {Promise<{queued:boolean, reason:string}>} never throws. */
export async function requeueProfileForRepeatedBlocks(site, deps = {}, now = new Date()) {
  return requeue(site, deps, now, { requireRepeat: true });
}

// A repair diagnosed the cause as the captured design itself (design-repair.js):
// that is evidence in hand, so it does not wait for the block to repeat. Every
// other safeguard stays — one job already queued is enough, and the cooldown
// still stops a job per draft.
/** @returns {Promise<{queued:boolean, reason:string}>} never throws. */
export async function requestProfileRefresh(site, deps = {}, now = new Date()) {
  return requeue(site, deps, now, { requireRepeat: false });
}
