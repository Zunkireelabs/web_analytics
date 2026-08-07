import { query } from '../db.js';

// CRUD for the recommendations table — the Recommendation Coordinator's only
// persistence layer (see agents/lib/recommendation-coordinator.js, which is
// the only caller allowed to invoke the writes below). Dedup key is
// (site_id, page, recommendation_type); the DB enforces it via
// recommendations_dedup_key (migration 077), these helpers just implement
// the read-before-write merge on top of it.

export async function findOpenRecommendation(siteId, page, recommendationType) {
  const { rows } = await query(
    `SELECT * FROM recommendations WHERE site_id = $1 AND page = $2 AND recommendation_type = $3 AND status = 'open'`,
    [siteId, page, recommendationType]
  );
  return rows[0] || null;
}

export async function insertRecommendation(siteId, {
  page, recommendationType, issue, reason, params, findingId, detectingAgent, priority, expectedImpact, riskTier,
}) {
  const { rows } = await query(
    `INSERT INTO recommendations
       (site_id, page, recommendation_type, issue, reason, params, finding_ids, detecting_agents, priority, expected_impact, risk_tier)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      siteId, page, recommendationType, issue, reason || null, JSON.stringify(params || {}),
      [findingId], [detectingAgent], priority || 'medium', expectedImpact ? JSON.stringify(expectedImpact) : null,
      riskTier || 'manual',
    ]
  );
  return rows[0];
}

// Merges a fresh grounded finding into an already-open recommendation row:
// adds the finding id, and adds the agent to supporting_agents unless it's
// already the original detector or already recorded; refreshes the evidence
// fields to the latest sync's values. detecting_agents is set once at
// insertRecommendation and never mutated here — it's "who found it first,"
// supporting_agents is "who else corroborated it." Never changes `status` —
// closing a recommendation is out of scope for M1 (see
// recommendation-coordinator.js's syncFromGrounded doc comment).
export async function mergeIntoRecommendation(id, { findingId, agentId, reason, params, priority, expectedImpact }) {
  const { rows } = await query(
    `UPDATE recommendations SET
       finding_ids = (SELECT ARRAY(SELECT DISTINCT unnest(finding_ids || $2::text[]))),
       supporting_agents = CASE
         WHEN $3 = ANY(detecting_agents) OR $3 = ANY(supporting_agents) THEN supporting_agents
         ELSE supporting_agents || $3::text
       END,
       reason = COALESCE($4, reason),
       params = COALESCE($5, params),
       priority = COALESCE($6, priority),
       expected_impact = COALESCE($7, expected_impact),
       last_seen_at = now(),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id, [findingId], agentId, reason || null,
      params ? JSON.stringify(params) : null, priority || null,
      expectedImpact ? JSON.stringify(expectedImpact) : null,
    ]
  );
  return rows[0];
}

export async function listOpenRecommendations(siteId) {
  const { rows } = await query(
    `SELECT * FROM recommendations WHERE site_id = $1 AND status = 'open' ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen_at DESC`,
    [siteId]
  );
  return rows;
}

export async function getRecommendationById(siteId, id) {
  const { rows } = await query('SELECT * FROM recommendations WHERE site_id = $1 AND id = $2', [siteId, id]);
  return rows[0] || null;
}

// Closes a single recommendation on demand — used by the manual "re-check
// now" action (recommendation-coordinator.js's recheckRecommendation), as
// opposed to closeStaleRecommendations' bulk sweep on every sync.
export async function closeRecommendation(id) {
  await query(`UPDATE recommendations SET status = 'superseded', updated_at = now() WHERE id = $1`, [id]);
}

// risk_tier is not currently exposed on execution_job_id's caller, but every
// safe-tier recommendation not already claimed by an in-flight job is a
// candidate for executeSafeFixes (agents/lib/execution-engine.js) —
// excludes anything with a non-null execution_job_id so a recommendation
// already queued/shipped by an earlier job is never picked up twice.
export async function listOpenSafeRecommendations(siteId, limit) {
  const { rows } = await query(
    `SELECT * FROM recommendations WHERE site_id = $1 AND status = 'open' AND risk_tier = 'safe' AND execution_job_id IS NULL
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen_at DESC
       LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}

export async function setRecommendationExecutionState(id, { executionJobId, executionStatus }) {
  await query(
    'UPDATE recommendations SET execution_job_id = COALESCE($2, execution_job_id), execution_status = COALESCE($3, execution_status), updated_at = now() WHERE id = $1',
    [id, executionJobId ?? null, executionStatus ?? null]
  );
}

// Closes every currently-open row whose (recommendation_type, page) key is
// not in stillDetectedKeys — i.e. the agent that originally flagged it
// re-ran and no longer finds the issue. `superseded` (not `dismissed`,
// which means a human said "not relevant") and it frees the row's dedup
// key (recommendations_dedup_key is a partial unique index scoped to
// status = 'open'), so if the same page + type genuinely regresses later
// it opens a brand new row rather than being blocked by this closed one.
// Called once per site per sync from recommendation-coordinator.js's
// syncFromGrounded — see that file for how stillDetectedKeys is built.
//
// checked = { agentCheckedKeys, linkCrawlCheckedKeys, batchRotatedAgentIds },
// built by buildRecommendations (agents/lib/recommendations.js). Most agents
// only examine a bounded rotation batch per run — a page missing from this
// run's findings usually means "not re-checked today," not "fixed," so
// closing on absence alone was making recommendations vanish in bulk (then
// often reappear later) without ever being confirmed clean. A stale row is
// only closed when we're sure it was actually re-verified:
//   - no page (site-level/collapsed key, e.g. cookie-policy, security-headers
//     as a fix action): unchanged — these are recomputed in full every run
//   - broken-link-fix: only if the page's outbound links were part of this
//     run's link crawl (narrower than its agent's own page batch — see
//     technical-seo-analysis.js)
//   - everything else: only if every agent that originally flagged it either
//     isn't rotation-batched (checks everything every run, so its silence is
//     already trustworthy) or did re-check this exact page this run
export async function closeStaleRecommendations(siteId, stillDetectedKeys, checked = {}) {
  const { agentCheckedKeys, linkCrawlCheckedKeys, batchRotatedAgentIds } = checked;
  const { rows } = await query(
    `SELECT id, page, recommendation_type, detecting_agents FROM recommendations WHERE site_id = $1 AND status = 'open'`,
    [siteId]
  );
  const staleIds = rows
    .filter((r) => {
      const key = `${r.recommendation_type}::${r.page}`;
      if (stillDetectedKeys.has(key)) return false;
      if (!r.page) return true;
      if (r.recommendation_type === 'broken-link-fix') return !!linkCrawlCheckedKeys?.has(r.page);
      return (r.detecting_agents || []).every((agentId) => (
        !batchRotatedAgentIds?.has(agentId) || !!agentCheckedKeys?.has(`${agentId}::${r.page}`)
      ));
    })
    .map((r) => r.id);
  if (!staleIds.length) return 0;
  await query(
    `UPDATE recommendations SET status = 'superseded', updated_at = now() WHERE id = ANY($1::int[])`,
    [staleIds]
  );
  return staleIds.length;
}
