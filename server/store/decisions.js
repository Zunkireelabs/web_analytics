import { query } from '../db.js';

// CRUD for the `decisions` table (migration 166) — decision-engine.js's only
// persistence layer. Mirrors store/recommendations.js's shape (plain query
// wrappers, no business logic) rather than putting SQL inline in
// decision-engine.js, so the reasoning module stays testable via dependency
// injection (see agents/lib/recommendation-gates.js's createRecommendationGates
// pattern) without needing a real DB in its own unit tests.

export async function insertDecision(siteId, {
  situation, evidence, rootCause = null, missingEvidence = [], action, actionTarget = null,
  rationale, alternativesConsidered = [], confidence, validationPlan = null,
}) {
  const { rows } = await query(
    `INSERT INTO decisions
       (site_id, situation, evidence, root_cause, missing_evidence, action, action_target,
        rationale, alternatives_considered, confidence, validation_plan)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      siteId, situation, JSON.stringify(evidence || []), rootCause ? JSON.stringify(rootCause) : null,
      JSON.stringify(missingEvidence || []), action, actionTarget ? JSON.stringify(actionTarget) : null,
      rationale, JSON.stringify(alternativesConsidered || []), confidence, validationPlan,
    ]
  );
  return rows[0];
}

export async function getDecision(id) {
  const { rows } = await query('SELECT * FROM decisions WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function listDecisionsForSite(siteId, { limit = 50, action } = {}) {
  const { rows } = action
    ? await query(
        'SELECT * FROM decisions WHERE site_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT $3',
        [siteId, action, limit]
      )
    : await query(
        'SELECT * FROM decisions WHERE site_id = $1 ORDER BY created_at DESC LIMIT $2',
        [siteId, limit]
      );
  return rows;
}

// Links a decision forward once its resulting action is shipped and
// verified (Phase 10's learning-loop connection to agent_fix_memory /
// fix-impact.js) — a separate call from insertDecision because a decision
// is recorded at reasoning time, long before an outcome exists.
export async function setDecisionOutcome(id, { status, outcomeRef }) {
  const { rows } = await query(
    `UPDATE decisions SET status = $2, outcome_ref = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status, outcomeRef ?? null]
  );
  return rows[0] || null;
}
