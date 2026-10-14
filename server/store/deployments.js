import { query } from '../db.js';

// Post-merge deploy state (migration 153).
//
// Before this existed, a merged PR was silently treated as a shipped change:
// drafts went pr_opened -> implemented the moment a human clicked Merge, and
// nothing ever asked whether the change actually reached the live site. A
// merge that never deployed — a failed build on the client's host, a paused
// deploy hook, a branch wired to nothing — was indistinguishable from a
// successful one.
//
// Client repos deploy on push, so there is no deploy API to call; the only
// honest signal available from here is the live site itself reflecting the
// merged content. That check belongs to fix-verification.js, which reports
// back through markDeploymentDetected/markDeploymentNotDetected. This module
// only owns the record.
//
// Keyed per (site_id, commit_sha) rather than per draft on purpose: one merge
// commonly carries a whole day's batch (one branch, one commit, one PR — see
// implementers/lib/github-ops.js), and every draft in it deploys together.

// How long a merge is given to become live before its absence stops being
// "still deploying" and becomes real evidence that it never shipped. Static
// hosts rebuild in minutes; this is deliberately generous so a slow build is
// never mistaken for a failure.
export const DEPLOY_GRACE_HOURS = Number(process.env.DEPLOY_GRACE_HOURS) || 6;

// Idempotent: the PR poller, the webhook and the manual "check PR status"
// button all land on the same merge, and a batch PR carries many drafts that
// each finalize separately. First writer creates the row, everyone else gets
// the existing one back untouched — in particular a re-observed merge must
// never reset a deployment already confirmed live.
export async function recordDeploymentObserved(siteId, { commitSha, prNumber, prUrl }) {
  if (!commitSha) return null;
  const { rows } = await query(
    `INSERT INTO deployments (site_id, commit_sha, pr_number, pr_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, commit_sha) DO UPDATE
       SET pr_number = COALESCE(deployments.pr_number, EXCLUDED.pr_number),
           pr_url    = COALESCE(deployments.pr_url, EXCLUDED.pr_url)
     RETURNING *`,
    [siteId, commitSha, prNumber ?? null, prUrl ?? null],
  );
  return rows[0] || null;
}

export async function getDeploymentById(id) {
  if (!id) return null;
  const { rows } = await query('SELECT * FROM deployments WHERE id = $1', [id]);
  return rows[0] || null;
}

// A real live-site re-fetch found the shipped change present. That is the
// only thing that promotes a deployment out of 'pending' — never a timer,
// never the merge itself.
export async function markDeploymentDetected(id, evidence) {
  const { rows } = await query(
    `UPDATE deployments
        SET status = 'deployed', deployed_at = COALESCE(deployed_at, now()),
            evidence = $2, updated_at = now()
      WHERE id = $1 AND status <> 'deployed'
      RETURNING *`,
    [id, JSON.stringify(evidence ?? null)],
  );
  return rows[0] || null;
}

// The grace window elapsed with no evidence the merge ever went live. Recorded
// as its own state rather than folded into the verification's failure, so
// "this whole deploy never happened" reads differently from "this one fix
// deployed and is still wrong".
export async function markDeploymentNotDetected(id, evidence) {
  const { rows } = await query(
    `UPDATE deployments
        SET status = 'not-detected', evidence = $2, updated_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, JSON.stringify(evidence ?? null)],
  );
  return rows[0] || null;
}

export async function listDeploymentsForSite(siteId, { limit = 50 } = {}) {
  const { rows } = await query(
    'SELECT * FROM deployments WHERE site_id = $1 ORDER BY merged_at DESC LIMIT $2',
    [siteId, limit],
  );
  return rows;
}

export function deploymentGraceElapsed(deployment, now = new Date()) {
  if (!deployment?.merged_at) return false;
  const mergedAt = new Date(deployment.merged_at).getTime();
  return now.getTime() - mergedAt > DEPLOY_GRACE_HOURS * 60 * 60 * 1000;
}
