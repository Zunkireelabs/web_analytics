import { query } from '../db.js';
import { operatorDetail } from '../lib/errors.js';

// Checkpoints for the unified daily pipeline (migration 241). One row per (project, day, stage).
//
// THE RULE: every write is idempotent, and a stage that already finished today is never started again. A crash, a deploy or a
// second process can land between any two statements, and the next pass works out what happened from the row alone.

// Tries to take a stage for a project and day. Returns { start: true, attempt } when this caller should run it, or
// { start: false, status } when it must not: it already finished, was skipped, is running right now, or used up its attempts.
// A stage that is 'failed' or 'deferred' may be taken again (counted as another attempt) until maxAttempts.
export async function beginStage(siteId, runDate, stage, { maxAttempts = 3 } = {}) {
  const inserted = await query(
    `INSERT INTO daily_pipeline_runs (site_id, run_date, stage, status, attempts)
     VALUES ($1, $2, $3, 'running', 1)
     ON CONFLICT (site_id, run_date, stage) DO NOTHING
     RETURNING attempts`, [siteId, runDate, stage]);
  if (inserted.rows[0]) return { start: true, attempt: 1 };

  // A row exists. Re-take it only when it is failed or deferred, and only while attempts remain; the WHERE makes it atomic, so two
  // processes cannot both win.
  const retaken = await query(
    `UPDATE daily_pipeline_runs
        SET status = 'running', attempts = attempts + 1, started_at = now(), finished_at = NULL, error = NULL
      WHERE site_id = $1 AND run_date = $2 AND stage = $3
        AND status IN ('failed', 'deferred') AND attempts < $4
      RETURNING attempts`, [siteId, runDate, stage, maxAttempts]);
  if (retaken.rows[0]) return { start: true, attempt: retaken.rows[0].attempts };

  const { rows } = await query(
    `SELECT status, attempts FROM daily_pipeline_runs WHERE site_id = $1 AND run_date = $2 AND stage = $3`, [siteId, runDate, stage]);
  return { start: false, status: rows[0]?.status ?? 'unknown', attempts: rows[0]?.attempts ?? 0 };
}

export async function finishStage(siteId, runDate, stage, { details = {} } = {}) {
  await query(
    `UPDATE daily_pipeline_runs SET status = 'done', finished_at = now(), error = NULL, details = $4::jsonb
      WHERE site_id = $1 AND run_date = $2 AND stage = $3`, [siteId, runDate, stage, JSON.stringify(details)]);
}

export async function failStage(siteId, runDate, stage, error) {
  await query(
    `UPDATE daily_pipeline_runs SET status = 'failed', finished_at = now(), error = $4
      WHERE site_id = $1 AND run_date = $2 AND stage = $3`, [siteId, runDate, stage, operatorDetail(error, 500)]);
}

// The stage did not start (the deadline had passed, or an earlier required stage failed). Its work stays queued.
export async function deferStage(siteId, runDate, stage, reason) {
  await query(
    `INSERT INTO daily_pipeline_runs (site_id, run_date, stage, status, attempts, finished_at, error)
     VALUES ($1, $2, $3, 'deferred', 0, now(), $4)
     ON CONFLICT (site_id, run_date, stage) DO UPDATE SET status = 'deferred', finished_at = now(), error = EXCLUDED.error
       WHERE daily_pipeline_runs.status IN ('failed', 'deferred')`, [siteId, runDate, stage, reason]);
}

export async function skipStage(siteId, runDate, stage, reason) {
  await query(
    `INSERT INTO daily_pipeline_runs (site_id, run_date, stage, status, finished_at, details)
     VALUES ($1, $2, $3, 'skipped', now(), $4::jsonb)
     ON CONFLICT (site_id, run_date, stage) DO NOTHING`, [siteId, runDate, stage, JSON.stringify({ reason })]);
}

// A pass that was killed mid-stage leaves a 'running' row behind. Anything running for longer than a stage can possibly take is
// handed back so the next pass can retake it.
export async function releaseStaleStages({ olderThanMinutes = 90 } = {}) {
  const { rowCount } = await query(
    `UPDATE daily_pipeline_runs SET status = 'failed', finished_at = now(), error = 'abandoned: the process stopped mid-stage'
      WHERE status = 'running' AND started_at < now() - ($1 || ' minutes')::interval`, [String(olderThanMinutes)]);
  return rowCount;
}

export async function listStages(siteId, runDate) {
  const { rows } = await query(
    `SELECT stage, status, attempts, started_at, finished_at, error FROM daily_pipeline_runs
      WHERE site_id = $1 AND run_date = $2 ORDER BY started_at`, [siteId, runDate]);
  return rows;
}
