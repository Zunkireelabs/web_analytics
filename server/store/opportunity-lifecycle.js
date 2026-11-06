import { query } from '../db.js';

// Where a competitor opportunity actually stands (migration 234), derived from the records the pipeline already
// writes rather than from an event hook at every call site.
//
// Deriving it is the deliberate choice. A hook on "draft created", another on "PR merged" and another on "deployed"
// would be three places to forget, and a missed hook would leave an opportunity stuck in a state that no longer
// matches reality — then be read as a result that never happened. Reading drafts, deployments and fix_impact makes
// the state self-correcting: whatever actually happened is what it says, and a re-run converges rather than drifts.
//
// The join key is the finding id the existing gap pipeline already stamps on a draft: `keyword-gap:<gap id>`
// (gapDraftEligibility's findingId). Nothing new is written on the draft side.
//
// The ladder, and what each rung is allowed to mean:
//   drafted   a draft exists for this gap. NOT a result: nothing has reached the site.
//   merged    its PR is merged. Still not a result: merged is not live.
//   deployed  a deployment carrying that PR succeeded.
//   verified  fix_impact has measured the window after the change. Only this rung may feed learning.

export const LIFECYCLE_ORDER = ['discovered', 'drafted', 'merged', 'deployed', 'verified'];

export async function deriveOpportunityLifecycle(siteId, { limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT g.id AS gap_id, g.topic, g.opportunity_type, g.lifecycle_state,
            d.id AS draft_id, d.status AS draft_status, d.pr_number, d.pr_state, d.implemented_at,
            dep.status AS deployment_status, dep.deployed_at,
            fi.id AS fix_impact_id, fi.measured_at, fi.status AS impact_status, fi.delta
       FROM keyword_gaps g
       LEFT JOIN drafts d
              ON d.site_id = g.site_id
             AND d.finding_id = 'keyword-gap:' || g.id
       LEFT JOIN deployments dep
              ON dep.site_id = g.site_id
             AND dep.pr_number = d.pr_number
             AND d.pr_number IS NOT NULL
       LEFT JOIN fix_impact fi
              ON fi.site_id = g.site_id
             AND fi.draft_id = d.id
      WHERE g.site_id = $1 AND g.source = 'competitor_footprint'
      ORDER BY g.opportunity_score DESC NULLS LAST
      LIMIT $2`,
    [siteId, Math.min(Math.max(Number(limit) || 200, 1), 2000)]
  );
  return rows.map((r) => ({ ...r, derivedState: stateFor(r) }));
}

// The honest reading of one row. Order matters: the furthest stage with real evidence wins, and anything short of a
// measured impact window is never 'verified'.
export function stateFor(row) {
  if (row.fix_impact_id && row.measured_at && row.impact_status === 'measured') return 'verified';
  // 'deployed' is the deployments table's own success value (its status is pending | deployed | not-detected), and
  // deployed_at must be set: a row that only says it is deployed without a time has not been observed live.
  if (row.deployment_status === 'deployed' && row.deployed_at) return 'deployed';
  // 'merged' comes from the PR's own state, not from the draft being approved: an approved draft whose PR is still
  // open has changed nothing on the site.
  if (row.pr_state === 'merged' || row.implemented_at) return 'merged';
  if (row.draft_id) return 'drafted';
  return 'discovered';
}

// Moves every opportunity whose derived state is further along than its stored one. Forward only (the UPDATE's own
// array_position guard), so a deleted draft or a repeated run can never walk a verified outcome backwards.
export async function reconcileOpportunityLifecycles(siteId, { limit = 200 } = {}) {
  const rows = await deriveOpportunityLifecycle(siteId, { limit });
  const advanced = [];
  for (const row of rows) {
    if (LIFECYCLE_ORDER.indexOf(row.derivedState) <= LIFECYCLE_ORDER.indexOf(row.lifecycle_state)) continue;
    const { rows: updated } = await query(
      `UPDATE keyword_gaps SET lifecycle_state = $3, lifecycle_changed_at = now()
        WHERE site_id = $1 AND id = $2
          AND array_position($4::text[], lifecycle_state) < array_position($4::text[], $3)
        RETURNING id, lifecycle_state`,
      [siteId, row.gap_id, row.derivedState, LIFECYCLE_ORDER]
    );
    if (updated[0]) advanced.push({ gapId: row.gap_id, topic: row.topic, from: row.lifecycle_state, to: row.derivedState });
  }
  return { checked: rows.length, advanced };
}

// Opportunities that have reached a measured outcome and have not yet been counted towards what this project has
// learned. `outcome_counted` lives on the gap so a reconcile run is idempotent: counting the same verified outcome
// twice would teach the scorer from one event repeated, which is how a system convinces itself of something false.
export async function listUncountedVerifiedOutcomes(siteId, { limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT g.id AS gap_id, g.topic, g.opportunity_type, fi.delta, fi.before_window, fi.measured_at
       FROM keyword_gaps g
       JOIN drafts d ON d.site_id = g.site_id AND d.finding_id = 'keyword-gap:' || g.id
       JOIN fix_impact fi ON fi.site_id = g.site_id AND fi.draft_id = d.id
      WHERE g.site_id = $1 AND g.source = 'competitor_footprint'
        AND g.lifecycle_state = 'verified'
        AND g.outcome_counted IS NOT TRUE
        AND fi.status = 'measured' AND fi.measured_at IS NOT NULL
        AND g.opportunity_type IS NOT NULL
      ORDER BY fi.measured_at
      LIMIT $2`,
    [siteId, Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return rows;
}

export async function markOutcomeCounted(siteId, gapId) {
  const { rows } = await query(
    'UPDATE keyword_gaps SET outcome_counted = true WHERE site_id = $1 AND id = $2 AND outcome_counted IS NOT TRUE RETURNING id',
    [siteId, gapId]
  );
  return !!rows[0];
}
