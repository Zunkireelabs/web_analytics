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
// the job. recommendationId is nullable — a componentTemplates-derivation
// job (see createComponentTemplateJob below) has no recommendations row to
// attach to.
export async function createDesignAgentJob(siteId, recommendationId, { requestedBy, params } = {}) {
  const { rows } = await query(
    `INSERT INTO execution_jobs (site_id, trigger, kind, status, recommendation_id, requested_by, params)
     VALUES ($1, 'single', 'design_generate', 'queued', $2, $3, $4::jsonb)
     RETURNING *`,
    [siteId, recommendationId, requestedBy || null, JSON.stringify(params || {})]
  );
  return rows[0];
}

// componentTemplates integration (090): a design_generate job whose task is
// "inspect the real repo and derive/refresh {wrapper,row} markup for these
// action types" rather than "act on one recommendation" — recommendation_id
// is null (nothing to attach to), and `componentKeys` (the
// design-drift.js/marker-merge.js action-type strings, e.g. ['faq',
// 'expand-content']) travels in `params` for the worker's handler to read
// off the claimed job row.
// Is there already an unfinished componentTemplates derivation pending for
// this site + component key? Used by design-drift.js's
// resolveOrCreateComponentTemplate to enqueue at most ONE outstanding
// re-derivation per site+key: that function sits on generateDraft's hot path,
// so without this check every draft attempt against a site with an unverified
// template would queue another job for work already pending — a single daily
// run would add dozens.
//
// Matched on ACTION TYPE ('expand-content'), not the componentTemplates key
// ('expandContent') — createComponentTemplateJob stores whatever its
// `componentKeys` argument was, and every caller passes action types. The two
// vocabularies are identical for faq/qaContent-style names and differ for the
// hyphenated ones, so querying by the wrong one would silently never match
// and re-queue forever.
//
// Treats both 'queued' and 'executing' as pending: a job a worker has already
// claimed is still going to produce the template.
//
// jsonb_exists() rather than the `?` operator, which node-postgres parses as
// a placeholder and would break the query.
export async function getQueuedComponentTemplateJob(siteId, actionType) {
  const { rows } = await query(
    `SELECT id FROM execution_jobs
     WHERE site_id = $1 AND kind = 'design_generate' AND status IN ('queued', 'executing')
       AND jsonb_exists(params->'componentKeys', $2)
     ORDER BY id DESC LIMIT 1`,
    [siteId, actionType]
  );
  return rows[0] || null;
}

// Sentinel stored in params.componentKeys for a whole-site design-profile
// job, so getQueuedComponentTemplateJob's existing "is one already pending"
// check works unchanged for it. Not an action type — deliberately a reserved
// name no COMPONENT_TEMPLATE_KEY will ever collide with.
export const DESIGN_PROFILE_JOB_KEY = '__design-profile__';

// Derives the SITE'S whole design language (design-agent/lib/design-profile.js),
// which every per-component template is then projected from. Takes no action
// types — the whole site is the scope, which is exactly what makes one of
// these worth more than N component-template jobs.
export async function createDesignProfileJob(siteId, { requestedBy, pageUrl } = {}) {
  return createDesignAgentJob(siteId, null, {
    requestedBy,
    params: { mode: 'design-profile', componentKeys: [DESIGN_PROFILE_JOB_KEY], pageUrl: pageUrl || null },
  });
}

export async function createComponentTemplateJob(siteId, componentKeys, { requestedBy, pageUrl } = {}) {
  return createDesignAgentJob(siteId, null, { requestedBy, params: { mode: 'component-templates', componentKeys, pageUrl: pageUrl || null } });
}

// Step 6B: atomically claims the oldest queued design_generate job for the
// calling worker process. SELECT ... FOR UPDATE SKIP LOCKED inside its own
// transaction is what makes this safe under N concurrent worker processes —
// a row already locked by another worker's in-flight claim is invisible to
// this query rather than something this query blocks on, so two workers can
// never both claim the same job. Returns null (not a rejected promise) when
// the queue is empty, same "empty is a normal outcome" convention as the
// rest of this file's read helpers.
//
// siteId is optional and defaults to unscoped (every real worker.js
// deployment polls globally, across every tenant, by design). It exists so
// a caller that already knows it only ever wants ITS OWN site's jobs — in
// practice, worker.test.js's fixtures — can't accidentally claim (and
// fake-complete with a mock handler) some other site's real queued job.
export async function claimNextDesignAgentJob(siteId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: candidates } = await client.query(
      `SELECT id FROM execution_jobs
       WHERE kind = 'design_generate' AND status = 'queued'
         AND ($1::int IS NULL OR site_id = $1)
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [siteId]
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

// `result` (090) is the handler's own return value (e.g. the
// componentTemplates a design_generate job derived) — optional and additive,
// COALESCEd like branch_name/pr_number/pr_url above, so every existing
// caller that never passes it is unaffected.
export async function finishExecutionJob(executionJobId, { status, branchName, prNumber, prUrl, result }) {
  const { rows } = await query(
    `UPDATE execution_jobs SET
       status = $2, branch_name = COALESCE($3, branch_name), pr_number = COALESCE($4, pr_number), pr_url = COALESCE($5, pr_url),
       result = COALESCE($6::jsonb, result),
       finished_at = now(), duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000
     WHERE id = $1
     RETURNING *`,
    [executionJobId, status, branchName || null, prNumber || null, prUrl || null, result != null ? JSON.stringify(result) : null]
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
