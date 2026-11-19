import { query } from '../db.js';

// Scheduling state of the setup PR (migration 256). Every function is keyed by siteId and touches only the setup_pr_* columns.

export const MAX_SETUP_PR_ATTEMPTS = 4;

// Sets when the setup PR may run. Never moves a project that is already done, and never schedules a done project again.
// Returns the row's due time, or null when nothing was scheduled (already done, or no such project).
export async function scheduleSetupPr(siteId, dueAt) {
  const { rows } = await query(
    `UPDATE sites SET setup_pr_due_at = $2, setup_pr_attempts = 0, setup_pr_last_error = NULL
      WHERE id = $1 AND setup_pr_done_at IS NULL
      RETURNING setup_pr_due_at`,
    [siteId, dueAt]);
  return rows[0]?.setup_pr_due_at ?? null;
}

// Cancels a schedule that has not run yet.
export async function clearSetupPrSchedule(siteId) {
  const { rowCount } = await query('UPDATE sites SET setup_pr_due_at = NULL WHERE id = $1 AND setup_pr_done_at IS NULL', [siteId]);
  return rowCount === 1;
}

// Ids of projects whose time has come, oldest first. Capped attempts are left alone until someone reschedules them.
export async function listDueSetupPrSiteIds(now = new Date(), limit = 1) {
  const { rows } = await query(
    `SELECT id FROM sites
      WHERE setup_pr_due_at IS NOT NULL AND setup_pr_due_at <= $1
        AND setup_pr_done_at IS NULL AND setup_pr_attempts < $2
      ORDER BY setup_pr_due_at ASC, id ASC LIMIT $3`,
    [now, MAX_SETUP_PR_ATTEMPTS, limit]);
  return rows.map((r) => r.id);
}

// Where one project stands, for the rollout order. Null when there is no such project.
export async function getSetupPrState(siteId) {
  const { rows } = await query('SELECT id, setup_pr_due_at, setup_pr_done_at, setup_pr_attempts FROM sites WHERE id = $1', [siteId]);
  return rows[0] || null;
}

export async function recordSetupPrDone(siteId, result, now = new Date()) {
  await query(
    `UPDATE sites SET setup_pr_done_at = $2, setup_pr_result = $3::jsonb, setup_pr_last_error = NULL WHERE id = $1`,
    [siteId, now, JSON.stringify(result ?? {})]);
}

// Not ready yet (GitHub not connected, Auto-fixes off, baseline not done): looked at again later, and NOT counted as a failed attempt.
export async function deferSetupPr(siteId, reason, retryAt) {
  await query('UPDATE sites SET setup_pr_last_error = $2, setup_pr_due_at = $3 WHERE id = $1', [siteId, String(reason || '').slice(0, 300), retryAt]);
}

// A failed attempt: counted, remembered, and tried again later (backoff), until MAX_SETUP_PR_ATTEMPTS.
export async function recordSetupPrFailure(siteId, error, retryAt) {
  await query(
    `UPDATE sites SET setup_pr_attempts = setup_pr_attempts + 1, setup_pr_last_error = $2, setup_pr_due_at = $3 WHERE id = $1`,
    [siteId, String(error || 'failed').slice(0, 300), retryAt]);
}
