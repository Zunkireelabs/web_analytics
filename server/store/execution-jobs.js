import { query } from '../db.js';

// CRUD for execution_jobs / execution_job_recommendations (migration 078).
// Written to exclusively by agents/lib/execution-engine.js.

export async function createExecutionJob(siteId, { trigger, requestedBy }) {
  const { rows } = await query(
    `INSERT INTO execution_jobs (site_id, trigger, status, requested_by, started_at)
     VALUES ($1, $2, 'preparing', $3, now())
     RETURNING *`,
    [siteId, trigger, requestedBy || null]
  );
  return rows[0];
}

export async function addJobRecommendation(executionJobId, recommendationId) {
  const { rows } = await query(
    `INSERT INTO execution_job_recommendations (execution_job_id, recommendation_id)
     VALUES ($1, $2) RETURNING *`,
    [executionJobId, recommendationId]
  );
  return rows[0];
}

export async function updateJobRecommendationStatus(id, status, { draftId, error } = {}) {
  await query(
    `UPDATE execution_job_recommendations SET status = $2, draft_id = COALESCE($3, draft_id), error = $4, updated_at = now() WHERE id = $1`,
    [id, status, draftId ?? null, error || null]
  );
}

export async function appendJobLog(executionJobId, message) {
  await query(
    `UPDATE execution_jobs SET logs = logs || $2::jsonb WHERE id = $1`,
    [executionJobId, JSON.stringify([{ at: new Date().toISOString(), message }])]
  );
}

export async function finishExecutionJob(executionJobId, { status, branchName, prNumber, prUrl }) {
  const { rows } = await query(
    `UPDATE execution_jobs SET
       status = $2, branch_name = COALESCE($3, branch_name), pr_number = COALESCE($4, pr_number), pr_url = COALESCE($5, pr_url),
       finished_at = now(), duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
     WHERE id = $1
     RETURNING *`,
    [executionJobId, status, branchName || null, prNumber || null, prUrl || null]
  );
  return rows[0];
}

export async function getExecutionJob(siteId, id) {
  const { rows } = await query('SELECT * FROM execution_jobs WHERE site_id = $1 AND id = $2', [siteId, id]);
  if (!rows[0]) return null;
  const items = await query(
    `SELECT ejr.*, r.recommendation_type, r.issue, r.page
     FROM execution_job_recommendations ejr
     JOIN recommendations r ON r.id = ejr.recommendation_id
     WHERE ejr.execution_job_id = $1 ORDER BY ejr.id`,
    [id]
  );
  return { ...rows[0], items: items.rows };
}
