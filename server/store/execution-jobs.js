import { pool, query } from '../db.js';

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

// Design Agent job (089): status starts at 'queued', not 'preparing' like
// createExecutionJob above — a design_generate job has no worker to pick it
// up yet, so it must wait, unlike bulk/single jobs which execute inline in
// the same request. started_at is left null until a worker actually starts
// the job.
export async function createDesignAgentJob(siteId, recommendationId, { requestedBy } = {}) {
  const { rows } = await query(
    `INSERT INTO execution_jobs (site_id, trigger, kind, status, recommendation_id, requested_by)
     VALUES ($1, 'single', 'design_generate', 'queued', $2, $3)
     RETURNING *`,
    [siteId, recommendationId, requestedBy || null]
  );
  return rows[0];
}

// Step 6B: atomically claims the oldest queued design_generate job for the
// calling worker process. SELECT ... FOR UPDATE SKIP LOCKED inside its own
// transaction is what makes this safe under N concurrent worker processes —
// a row already locked by another worker's in-flight claim is invisible to
// this query rather than something this query blocks on, so two workers can
// never both claim the same job. Returns null (not a rejected promise) when
// the queue is empty, same "empty is a normal outcome" convention as the
// rest of this file's read helpers.
export async function claimNextDesignAgentJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: candidates } = await client.query(
      `SELECT id FROM execution_jobs
       WHERE kind = 'design_generate' AND status = 'queued'
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );
    if (!candidates[0]) {
      await client.query('COMMIT');
      return null;
    }
    const { rows } = await client.query(
      `UPDATE execution_jobs SET status = 'executing', started_at = now() WHERE id = $1 RETURNING *`,
      [candidates[0].id]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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

// Live "today" counters for the Action Center header — shipped/failed
// counted per execution_job_recommendations row (final status, not
// transient queued/drafted/submitted states), scoped to this site and
// today in the DB server's local date.
export async function getTodayExecutionStats(siteId) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE ejr.status = 'approved') AS shipped,
       count(*) FILTER (WHERE ejr.status = 'failed') AS failed
     FROM execution_job_recommendations ejr
     JOIN execution_jobs ej ON ej.id = ejr.execution_job_id
     WHERE ej.site_id = $1 AND ejr.updated_at >= date_trunc('day', now())`,
    [siteId]
  );
  return { shipped: Number(rows[0].shipped), failed: Number(rows[0].failed) };
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
