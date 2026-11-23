import { query as dbQuery } from '../db.js';
import { getSiteById } from '../store/read.js';
import { AGENT_BRANCH_PREFIX } from './pr-build-repair.js';

// Stale-branch guard. A batch branch is cut from the default branch on the day it is opened and the platform keeps it in step ONLY while it is
// pushing to it (github-ops.js getOrInitBatchBranch, today's branch). A batch PR that nobody merged the same day sits still while the default
// branch moves on, and the platform writes whole files from its own copy, so merging that PR can quietly put back something a person already
// fixed. Found 2026-11-23 on admizz-web-dev PR #119: cut Nov 21, it still listed the two Kathmandu/hub URLs that main renamed on Nov 22.
//
// For every open agent PR this reads how far its branch is behind the default branch and whether the default branch changed files the branch ALSO
// changes (the overlap is what a stale merge can revert).
//
// STALE_BATCH_GUARD (env):
//   off   does nothing
//   log   (the default) reports every branch that fell behind, naming the overlapping files, and writes nothing
//   sync  also merges the default branch INTO the agent branch when git can do it cleanly and the result passes the marker-corruption check
//         (the same operation getOrInitBatchBranch already performs every day on today's branch); a conflict is reported and left for a person
// Writes only ever go to an agent branch ("action-center/batch-*"), never to the default branch or to a stage branch, and never the other direction.
export const staleBatchMode = (env = process.env) => {
  const v = String(env.STALE_BATCH_GUARD || 'log').toLowerCase();
  return ['off', 'log', 'sync'].includes(v) ? v : 'log';
};

// Pure. `status` is compareBranchStatus's result.
export function assessBranch(status) {
  const behindBy = status?.behindBy ?? 0;
  if (behindBy <= 0) return { state: 'current', behindBy: 0, overlap: [] };
  const head = new Set(status.headFiles || []);
  const overlap = (status.baseFiles || []).filter((f) => head.has(f)).sort();
  // `truncated`: a file list hit GitHub's cap, so "no overlap" cannot be proven.
  return { state: overlap.length || status.truncated ? 'behind-overlap' : 'behind', behindBy, overlap, truncated: !!status.truncated };
}

export function describeAssessment(branch, prNumber, a, base) {
  const where = `${branch}${prNumber ? ` (PR #${prNumber})` : ''}`;
  if (a.state === 'current') return `${where} is up to date with ${base}.`;
  const head = `${where} is ${a.behindBy} commit${a.behindBy === 1 ? '' : 's'} behind ${base}`;
  if (a.state === 'behind-overlap') {
    const files = a.overlap.slice(0, 5).join(', ');
    return `${head}, and ${base} changed ${a.overlap.length ? `${a.overlap.length} file${a.overlap.length === 1 ? '' : 's'} this branch also changes (${files}${a.overlap.length > 5 ? ', ...' : ''})` : 'too many files to rule out an overlap'}: merging it as is could revert work already on ${base}.`;
  }
  return `${head}; none of the files ${base} changed since are ones this branch changes.`;
}

/**
 * @returns {Promise<{ mode, checked, current, behind, synced, held, failed }>}
 */
export async function checkOpenBatchBranches(siteId, { mode = staleBatchMode(), log = console.log, deps = {} } = {}) {
  const out = { mode, checked: 0, current: 0, behind: 0, synced: 0, held: 0, failed: 0 };
  if (mode === 'off') return out;
  const query = deps.query || dbQuery;
  const site = await (deps.getSiteById || getSiteById)(siteId);
  if (!site?.repo_owner || !site?.repo_name) return out;
  const compare = deps.compareBranchStatus || (await import('../github/client.js')).compareBranchStatus;
  const baseOf = deps.baseBranch || (await import('../implementers/lib/github-ops.js')).baseBranch;
  const base = baseOf(site);

  const { rows } = await query(
    `SELECT branch_name, MAX(pr_number) AS pr_number FROM drafts
      WHERE site_id = $1 AND pr_number IS NOT NULL AND COALESCE(pr_state, 'open') = 'open' AND status = 'pr_opened' AND branch_name LIKE $2
      GROUP BY branch_name`,
    [siteId, `${AGENT_BRANCH_PREFIX}%`],
  );
  for (const { branch_name: branch, pr_number: prNumber } of rows) {
    out.checked += 1;
    try {
      const a = assessBranch(await compare(site, base, branch));
      if (a.state === 'current') { out.current += 1; continue; }
      out.behind += 1;
      log?.(`[stale-batch] site ${siteId}: ${describeAssessment(branch, prNumber, a, base)}${mode === 'log' ? ' STALE_BATCH_GUARD=log, nothing was written.' : ''}`);
      if (mode !== 'sync') continue;
      const sync = deps.syncBranchWithBase || (await import('../implementers/lib/github-ops.js')).syncBranchWithBase;
      const r = await sync(site, branch);
      if (r.conflicted) { out.held += 1; log?.(`[stale-batch] site ${siteId}: ${branch} could not be brought up to date${r.corrupted ? ' (the merge left a duplicated marker)' : ' (merge conflict)'}; a person needs to resolve it on GitHub.`); }
      else if (r.synced) { out.synced += 1; log?.(`[stale-batch] site ${siteId}: ${branch} is now up to date with ${base}.`); }
    } catch (err) {
      // One branch's failure (GitHub trouble) must not stop the others.
      out.failed += 1;
      log?.(`[stale-batch] site ${siteId}: ${branch} could not be checked (${String(err.message || err).slice(0, 160)})`);
    }
  }
  return out;
}
