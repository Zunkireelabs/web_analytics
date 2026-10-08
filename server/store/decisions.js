import { query } from '../db.js';

// CRUD for the `decisions` table (migration 166) — decision-engine.js's only
// persistence layer. Mirrors store/recommendations.js's shape (plain query
// wrappers, no business logic) rather than putting SQL inline in
// decision-engine.js, so the reasoning module stays testable via dependency
// injection (see agents/lib/recommendation-gates.js's createRecommendationGates
// pattern) without needing a real DB in its own unit tests.

export async function insertDecision(siteId, {
  situation, evidence, rootCause = null, missingEvidence = [], action, actionTarget = null,
  rationale, alternativesConsidered = [], confidence, validationPlan = null, selfCritique = null,
}) {
  const { rows } = await query(
    `INSERT INTO decisions
       (site_id, situation, evidence, root_cause, missing_evidence, action, action_target,
        rationale, alternatives_considered, confidence, validation_plan, self_critique)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      siteId, situation, JSON.stringify(evidence || []), rootCause ? JSON.stringify(rootCause) : null,
      JSON.stringify(missingEvidence || []), action, actionTarget ? JSON.stringify(actionTarget) : null,
      rationale, JSON.stringify(alternativesConsidered || []), confidence, validationPlan,
      selfCritique ? JSON.stringify(selfCritique) : null,
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
// `outcomeRef` is COALESCEd rather than assigned (184): the lifecycle
// advances a decision several times — executing, shipped, verified — and
// only the last of those carries a fix_impact reference. Overwriting with
// NULL on the earlier transitions would erase the link each time. Pass an
// explicit value to replace it; omit it to leave whatever is there.
//
// status_changed_at moves only when the status actually changes, so a
// decision stuck in 'executing' is distinguishable from one that entered it
// a minute ago — `updated_at` cannot answer that, because any write touches it.
export async function setDecisionOutcome(id, { status, outcomeRef }) {
  const { rows } = await query(
    `UPDATE decisions
        SET status = $2,
            outcome_ref = COALESCE($3, outcome_ref),
            status_changed_at = CASE WHEN status <> $2 THEN now() ELSE status_changed_at END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, status, outcomeRef ?? null]
  );
  return rows[0] || null;
}

// The sweep's read: unfinished decisions, oldest first. Backed by
// decisions_open_idx (184). 'verified' and 'failed' are terminal and never
// come back.
export async function listOpenDecisions({ limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT id, site_id, status, action, action_target, outcome_ref, created_at, status_changed_at
       FROM decisions
      WHERE status IN ('decided', 'executing', 'shipped')
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// The decision behind a recommendation, if it had one. Backed by
// recommendations_decision_status_idx (184).
export async function getDecisionIdForRecommendation(recommendationId) {
  const { rows } = await query(
    'SELECT decision_id FROM recommendations WHERE id = $1',
    [recommendationId]
  );
  return rows[0]?.decision_id ?? null;
}

// The reverse direction, for the :40 impact sweep: a fix_impact row carries
// a finding_id but no recommendation_id, so the decision behind a
// MEASUREMENT is reachable only through the recommendation that owns that
// finding. Backed by recommendations_finding_ids_gin (184) — before that
// index, finding_ids had no index at all.
//
// site_id is required, not optional: finding ids are only unique within a
// site, and a cross-tenant match here would attribute one client's
// measurement to another client's decision.
export async function getDecisionIdForFinding(siteId, findingId) {
  if (!siteId || !findingId) return null;
  const { rows } = await query(
    `SELECT decision_id FROM recommendations
      WHERE site_id = $1 AND finding_ids @> ARRAY[$2]::text[] AND decision_id IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [siteId, findingId]
  );
  return rows[0]?.decision_id ?? null;
}

// Both hops at once, because that is what the impact sweep actually has:
// a draft id. drafts.finding_id (032) is the only link between a shipped
// artifact and the recommendation that asked for it — there is no
// drafts.recommendation_id column.
export async function getDecisionIdForDraft(siteId, draftId) {
  if (!siteId || !draftId) return null;
  const { rows } = await query(
    `SELECT r.decision_id
       FROM drafts d
       JOIN recommendations r
         ON r.site_id = d.site_id AND r.finding_ids @> ARRAY[d.finding_id]::text[]
      WHERE d.id = $1 AND d.site_id = $2 AND d.finding_id IS NOT NULL AND r.decision_id IS NOT NULL
      ORDER BY r.id DESC LIMIT 1`,
    [draftId, siteId]
  );
  return rows[0]?.decision_id ?? null;
}
