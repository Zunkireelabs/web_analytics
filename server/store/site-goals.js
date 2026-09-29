import { query } from '../db.js';

// CRUD for site_goals (migration 171) — the Business Goals feature's only
// persistence layer. Every function takes siteId and scopes its query by it;
// there is no function anywhere in this module that can read or write a goal
// without a site_id, which is what actually enforces "never a global
// default, always per-tenant" rather than leaving it to caller discipline.

export const GOAL_TYPES = Object.freeze([
  'generate_leads', 'increase_organic_traffic', 'increase_conversions',
  'reduce_bounce_rate', 'increase_organic_visibility', 'increase_qualified_traffic',
  'grow_bookings', 'grow_sales', 'custom',
]);

function shapeGoal(row) {
  if (!row) return null;
  return {
    id: row.id,
    siteId: row.site_id,
    goalType: row.goal_type,
    objective: row.objective,
    targetBusinessArea: row.target_business_area,
    targetPagePatterns: row.target_page_patterns || [],
    primaryMetric: row.primary_metric,
    description: row.description,
    status: row.status,
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createGoal(siteId, {
  goalType, objective, targetBusinessArea = null, targetPagePatterns = [],
  primaryMetric = null, description = null, importance = 1,
}) {
  if (!GOAL_TYPES.includes(goalType)) throw new Error(`Unknown goal type: ${goalType}`);
  if (!objective || !objective.trim()) throw new Error('objective is required — the goal type alone is not specific enough to match findings against');

  const { rows } = await query(
    `INSERT INTO site_goals
       (site_id, goal_type, objective, target_business_area, target_page_patterns, primary_metric, description, importance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [siteId, goalType, objective.trim(), targetBusinessArea, targetPagePatterns, primaryMetric, description, importance]
  );
  return shapeGoal(rows[0]);
}

// All goals (active + paused) for a site — Site Settings' own list view.
export async function listGoals(siteId) {
  const { rows } = await query(
    'SELECT * FROM site_goals WHERE site_id = $1 ORDER BY importance ASC, created_at ASC',
    [siteId]
  );
  return rows.map(shapeGoal);
}

// Active goals only, the evaluator's own input — ordered by importance so a
// caller picking "the goal that wins on a tie" can just take the first match.
export async function listActiveGoals(siteId) {
  const { rows } = await query(
    "SELECT * FROM site_goals WHERE site_id = $1 AND status = 'active' ORDER BY importance ASC, created_at ASC",
    [siteId]
  );
  return rows.map(shapeGoal);
}

export async function getGoal(siteId, goalId) {
  const { rows } = await query('SELECT * FROM site_goals WHERE site_id = $1 AND id = $2', [siteId, goalId]);
  return shapeGoal(rows[0]);
}

// Partial update — every field COALESCE'd so a caller editing just one field
// (e.g. pausing via setGoalStatus below, or a settings-UI form that only
// changed the objective) never blanks out the rest.
export async function updateGoal(siteId, goalId, {
  goalType, objective, targetBusinessArea, targetPagePatterns, primaryMetric, description, importance,
} = {}) {
  if (goalType !== undefined && !GOAL_TYPES.includes(goalType)) throw new Error(`Unknown goal type: ${goalType}`);
  const { rows } = await query(
    `UPDATE site_goals SET
       goal_type = COALESCE($3, goal_type),
       objective = COALESCE($4, objective),
       target_business_area = COALESCE($5, target_business_area),
       target_page_patterns = COALESCE($6, target_page_patterns),
       primary_metric = COALESCE($7, primary_metric),
       description = COALESCE($8, description),
       importance = COALESCE($9, importance),
       updated_at = now()
     WHERE site_id = $1 AND id = $2
     RETURNING *`,
    [siteId, goalId, goalType ?? null, objective ?? null, targetBusinessArea ?? null,
      targetPagePatterns ?? null, primaryMetric ?? null, description ?? null, importance ?? null]
  );
  return shapeGoal(rows[0]);
}

// Pause/reactivate — the one field a Site Settings UI needs to flip without
// resending the whole form, same "own dedicated toggle" shape
// setProspectDiscoveryEnabled uses.
export async function setGoalStatus(siteId, goalId, status) {
  if (status !== 'active' && status !== 'paused') throw new Error(`Invalid goal status: ${status}`);
  const { rows } = await query(
    `UPDATE site_goals SET status = $3, updated_at = now() WHERE site_id = $1 AND id = $2 RETURNING *`,
    [siteId, goalId, status]
  );
  return shapeGoal(rows[0]);
}
