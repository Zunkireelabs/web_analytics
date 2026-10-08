import { query } from '../db.js';

// Record every design-gate decision, blocked or not. See migration 186 for why
// the non-blocking ones matter most: log-only mode is how a fail-closed gate
// is rolled out without taking a fleet's output to zero.
//
// Never throws. A decision that cannot be recorded must not be able to fail a
// ship — the record is evidence about the gate, not part of the work.
export async function recordGateDecision(siteId, { draftId = null, actionType, gate, mode, blocked, reason = null, detail = {} }) {
  try {
    await query(
      `INSERT INTO design_gate_decisions (site_id, draft_id, action_type, gate, mode, blocked, reason, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [siteId, draftId, actionType, gate, mode, Boolean(blocked), reason, JSON.stringify(detail || {})]
    );
  } catch (err) {
    console.warn(`[design-gate] could not record a ${gate} decision for site ${siteId}: ${err.message}`);
  }
}

export async function setDraftRenderGate(draftId, renderGate) {
  if (!draftId) return;
  try {
    await query('UPDATE drafts SET render_gate = $2 WHERE id = $1', [draftId, JSON.stringify(renderGate)]);
  } catch (err) {
    console.warn(`[design-gate] could not store render_gate on draft ${draftId}: ${err.message}`);
  }
}

// What enforcing would do, per site: the read that decides whether it is safe.
export async function wouldBlockSummary({ days = 7 } = {}) {
  const { rows } = await query(
    `SELECT site_id, gate, count(*) FILTER (WHERE blocked)::int AS would_block, count(*)::int AS total
       FROM design_gate_decisions
      WHERE mode = 'log' AND created_at > now() - ($1::int * interval '1 day')
      GROUP BY site_id, gate ORDER BY would_block DESC`,
    [days]
  );
  return rows;
}
