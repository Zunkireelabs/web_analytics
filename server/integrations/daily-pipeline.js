import { query } from '../db.js';

export const meta = {
  id: 'daily-pipeline',
  label: 'Daily Automation Pipeline',
  category: 'internal',
  description: 'The nightly job that ingests data, runs every agent, and delivers notifications for each site — the thing the whole "we notice things and tell you" pitch depends on.',
};

// There's nothing to actively probe on demand — unlike an OAuth token, the
// pipeline's real health is only known by actually running it, and doing
// that from a "Test connection" click would mean re-running the full daily
// job (ingest + all agents + notifications) just to populate a button,
// which is slow and duplicates real work. So this just re-reads the same
// success/failure the job already recorded on itself the last time it ran
// (notePipelineOutcome in server/job.js) — shared across sites, same as
// google-oauth, since site_id is recorded as null there too.
export async function check() {
  const { rows } = await query(
    `SELECT status, auth_status, error_message, recovery_action
       FROM integration_health WHERE integration_id = $1 AND site_id IS NULL`,
    [meta.id]
  );
  const row = rows[0];
  if (!row) {
    return { ok: true, authStatus: 'unknown', errorMessage: null, recoveryAction: null };
  }
  return {
    ok: row.status === 'ok',
    authStatus: row.auth_status,
    errorMessage: row.error_message,
    recoveryAction: row.recovery_action,
  };
}
