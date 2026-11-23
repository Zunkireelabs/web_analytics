import { query as dbQuery } from '../db.js';
import { getSiteById } from '../store/read.js';
import { repairFailingBatchPr, AGENT_BRANCH_PREFIX } from './pr-build-repair.js';

// The scheduled half of build repair (lib/pr-build-repair.js): for each PR the agent has open on a site, read the build result and repair what failed.
//
// PR_BUILD_REPAIR (env):
//   off  does nothing
//   log  (the default) reads every open agent PR's build and LOGS what it would repair, and writes nothing to any client repository
//   on   also pushes the repair commit to the PR's own agent branch
// 'log' is the default on purpose: this loop writes to client repositories without a person in the way, so it is switched on by a person after reading
// what it would have done (`node server/scripts/repair-pr-build.js --site-id N --pr N` shows the same plan for one PR).
export const buildRepairMode = (env = process.env) => (['off', 'log', 'on'].includes(String(env.PR_BUILD_REPAIR || 'log').toLowerCase()) ? String(env.PR_BUILD_REPAIR || 'log').toLowerCase() : 'log');

/**
 * @returns {Promise<{ mode, checked, repaired, held, red }>}
 */
export async function repairOpenBatchPrBuilds(siteId, { mode = buildRepairMode(), log = console.log, deps = {} } = {}) {
  const out = { mode, checked: 0, repaired: 0, held: 0, red: 0 };
  if (mode === 'off') return out;
  const query = deps.query || dbQuery;
  const repair = deps.repairFailingBatchPr || repairFailingBatchPr;
  const site = await (deps.getSiteById || getSiteById)(siteId);
  if (!site?.repo_owner || !site?.repo_name) return out;

  // The open PRs on this site's agent branches, one row per PR.
  const { rows } = await query(
    `SELECT DISTINCT pr_number FROM drafts
      WHERE site_id = $1 AND pr_number IS NOT NULL AND COALESCE(pr_state, 'open') = 'open' AND status = 'pr_opened' AND branch_name LIKE $2`,
    [siteId, `${AGENT_BRANCH_PREFIX}%`],
  );
  for (const { pr_number: prNumber } of rows) {
    out.checked += 1;
    try {
      const r = await repair(site, prNumber, { apply: mode === 'on' });
      if (['repaired', 'held'].includes(r.outcome)) { out[r.outcome] += 1; log?.(`[build-repair] site ${siteId} PR #${prNumber}: ${r.outcome} (${r.failure?.kind}) ${r.plan?.actions.map((a) => `${a.op} ${a.path}`).join(', ')}`); }
      else if (r.outcome === 'planned') { out.red += 1; log?.(`[build-repair] site ${siteId} PR #${prNumber}: build is red; would ${r.plan.actions.map((a) => `${a.op} ${a.path}`).join(', ')} (${r.failure?.kind}). PR_BUILD_REPAIR=log, nothing was written.`); }
      else if (['not-ours', 'unknown', 'gave-up'].includes(r.outcome)) { out.red += 1; log?.(`[build-repair] site ${siteId} PR #${prNumber}: build is red and ${r.outcome}: ${r.reason}`); }
    } catch (err) {
      // One PR's failure (GitHub trouble, an unreadable log) must not stop the others.
      log?.(`[build-repair] site ${siteId} PR #${prNumber}: could not be checked (${String(err.message || err).slice(0, 160)})`);
    }
  }
  return out;
}
