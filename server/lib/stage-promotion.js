import { query as dbQuery } from '../db.js';
import { getSiteById } from '../store/read.js';
import { getPullRequest, openPullRequest, listOpenPullRequestsForBranch, defaultBranchName } from '../github/client.js';
import { checkClientBuildStatus } from '../implementers/lib/rendering-gate.js';

// After a person merges a client's batch pull request into its STAGE branch, the agent opens the stage -> main promotion PR
// (owner decision 2026-11-06; lib/pr-routing.js decides which batches go to stage at all). Rules:
//   - the agent NEVER merges: it opens the promotion PR and a person merges it;
//   - it opens it only after stage's own build check is green (a repo with no such check yet is not blocked, and the PR says so);
//   - one promotion PR covers every merged-but-unpromoted stage batch, and an already-open stage -> main PR is reused, never duplicated;
//   - every step is idempotent, so the hourly run can repeat it safely.

const loadBatches = async (query, siteId, stage) => (await query(
  `SELECT pr_number, array_agg(id ORDER BY id) AS draft_ids, min(pr_url) AS pr_url, bool_or(status = 'pr_opened') AS undecided
     FROM drafts WHERE site_id = $1 AND pr_base_branch = $2 AND pr_number IS NOT NULL GROUP BY pr_number ORDER BY pr_number`, [siteId, stage])).rows;
const loadDone = async (query, siteId) => new Map((await query(`SELECT source_pr_number, status FROM stage_promotions WHERE site_id = $1`, [siteId])).rows.map((r) => [r.source_pr_number, r.status]));
const remember = (query, siteId, prs, { status, number = null, url = null, note = null }) => Promise.all(prs.map((n) => query(
  `INSERT INTO stage_promotions (site_id, source_pr_number, status, promotion_pr_number, promotion_pr_url, note) VALUES ($1,$2,$3,$4,$5,$6)
   ON CONFLICT (site_id, source_pr_number) DO UPDATE SET status = EXCLUDED.status, promotion_pr_number = COALESCE(EXCLUDED.promotion_pr_number, stage_promotions.promotion_pr_number),
     promotion_pr_url = COALESCE(EXCLUDED.promotion_pr_url, stage_promotions.promotion_pr_url), note = EXCLUDED.note, updated_at = now()
   WHERE stage_promotions.status <> 'opened'`, [siteId, n, status, number, url, note])));

/**
 * One site. Returns { site, stage, checked, merged, opened: {number,url}|null, reused, waiting, blocked, reason }.
 * `deps` lets tests supply fakes shaped like GitHub's real answers.
 */
export async function promoteMergedStageBatches(siteId, deps = {}) {
  const {
    query = dbQuery, loadSite = getSiteById, readPr = getPullRequest, openPr = openPullRequest, listOpen = listOpenPullRequestsForBranch,
    buildStatus = checkClientBuildStatus, syncDrafts = null,
  } = deps;
  const out = { site: siteId, stage: null, checked: 0, merged: 0, opened: null, reused: false, waiting: false, blocked: false, reason: null };
  const site = await loadSite(siteId);
  const stage = String(site?.pr_target_branch || '').trim();
  const main = site ? defaultBranchName(site) : null;
  if (!site || !site.repo_owner || !site.repo_name || !stage || stage === main) return { ...out, reason: 'no-stage-branch' };
  out.stage = stage;

  const done = await loadDone(query, siteId);
  const mergedNow = [];
  for (const b of await loadBatches(query, siteId, stage)) {
    if (done.get(b.pr_number) === 'opened') continue;
    out.checked += 1;
    let pr;
    try { pr = await readPr(site, b.pr_number); } catch { continue; } // GitHub unreachable: try again next hour
    if (!pr?.merged) continue;                                        // still open, or closed without merging: nothing to promote
    if (b.undecided && syncDrafts) await syncDrafts(siteId, b.draft_ids).catch(() => {}); // lets Action Center show them as merged
    mergedNow.push(b);
  }
  out.merged = mergedNow.length;
  if (mergedNow.length === 0) return { ...out, reason: 'nothing-merged-on-stage' };
  const prNumbers = mergedNow.map((b) => b.pr_number);

  // Never open the promotion while stage's own build check is failing or still running.
  const build = await buildStatus(site, stage);
  if (build.reason === 'client-build-check-pending' || build.reason === 'client-build-check-unavailable') {
    await remember(query, siteId, prNumbers, { status: 'waiting', note: build.reason });
    return { ...out, waiting: true, reason: build.reason };
  }
  if (build.reason === 'client-build-check-failed') {
    await remember(query, siteId, prNumbers, { status: 'blocked', note: 'stage build check failed' });
    return { ...out, blocked: true, reason: build.reason };
  }
  const noCheck = build.reason === 'client-build-check-not-configured';

  // An open stage -> main PR already exists (opened by hand, or by an earlier run): use it, never a second.
  const open = (await listOpen(site, stage)).find((p) => p.base?.ref === main);
  if (open) {
    await remember(query, siteId, prNumbers, { status: 'opened', number: open.number, url: open.html_url, note: 'reused' });
    return { ...out, opened: { number: open.number, url: open.html_url }, reused: true };
  }
  const lines = mergedNow.map((b) => `- ${b.pr_url ? b.pr_url : `#${b.pr_number}`}`).join('\n');
  const { number, url } = await openPr(site, {
    branch: stage, base: main,
    title: `Promote ${stage} to ${main}: ${mergedNow.length} reviewed batch${mergedNow.length === 1 ? '' : 'es'}`,
    body: `This promotes \`${stage}\` into \`${main}\`.\n\nIt contains the batch${mergedNow.length === 1 ? '' : 'es'} a person already reviewed and merged on \`${stage}\`:\n${lines}\n\n`
        + (noCheck ? `No automated build check was found on \`${stage}\`, so please look at the stage site before merging.\n\n` : `\`${stage}\`'s build check passed.\n\n`)
        + `Review the diff and merge into \`${main}\` to publish. The agent never merges this for you.`,
  });
  await remember(query, siteId, prNumbers, { status: 'opened', number, url });
  return { ...out, opened: { number, url } };
}

// The scheduled run also lets Action Center see those drafts as merged, using the same check a person triggers with "Check PR status".
const syncMergedDrafts = async (siteId, draftIds) => {
  const { checkDraftPrStatus } = await import('../routes/action-center.js');
  for (const id of draftIds) await checkDraftPrStatus(siteId, id).catch(() => {});
};

/** Every client with a stage branch. One slow or failing client never stops the others. */
export async function runStagePromotionForAllSites(inDeps = {}) {
  const deps = { syncDrafts: syncMergedDrafts, ...inDeps };
  const query = deps.query || dbQuery;
  const { rows } = await query(`SELECT id FROM sites WHERE pr_target_branch IS NOT NULL AND pr_target_branch <> '' AND repo_owner IS NOT NULL AND status = 'active' ORDER BY id`);
  const totals = { sites: rows.length, opened: 0, waiting: 0, blocked: 0, failed: 0 };
  for (const { id } of rows) {
    try {
      const r = await promoteMergedStageBatches(id, deps);
      if (r.opened && !r.reused) totals.opened += 1; if (r.waiting) totals.waiting += 1; if (r.blocked) totals.blocked += 1;
    } catch (err) { totals.failed += 1; console.error(`[stage-promotion] site ${id}: ${err.message}`); }
  }
  return totals;
}
