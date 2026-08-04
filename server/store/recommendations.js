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
