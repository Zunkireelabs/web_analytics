import { query } from '../db.js';

// The queue behind the Claude Code worker (migration 267). The server enqueues what a generator would have sent to an AI API; a worker on a laptop
// claims it, writes the text and sends it back; the server carries on exactly as if the API had answered. Nothing here knows what the text is for.

export const WORKER_ONLINE_MS = 90_000;     // a worker that reported in within this long is "online"
export const STALE_CLAIM_MS = 5 * 60_000;   // a claimed request not answered within this goes back in the queue (the laptop slept or closed)
export const MAX_ATTEMPTS = 3;
export const RETENTION_DAYS = 7;
export const MAX_RESPONSE_CHARS = 90_000;   // the server's JSON body limit is 100kb; a longer answer is refused with a clear reason, not cut off

const open = (r) => (r && typeof r === 'object' ? r : null);

/** Puts a request in the queue; returns its id. `ttlMs` is how long the caller will wait: after it the request is no longer worth answering. */
export async function enqueueRequest({ siteId = null, generatorId = null, system, user, options = {}, ttlMs = 10 * 60_000 }) {
  const { rows } = await query(
    `INSERT INTO llm_requests (site_id, generator_id, system_text, user_text, options, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now() + ($6::int * interval '1 millisecond')) RETURNING id`,
    [siteId, generatorId, system, user, JSON.stringify(options || {}), Math.max(1000, Math.floor(ttlMs))],
  );
  return rows[0].id;
}

/** The caller's side: polls until the request is answered, failed or expired. Never waits longer than `timeoutMs`. */
export async function waitForRequest(id, { timeoutMs = 10 * 60_000, pollMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const { rows } = await query(`SELECT status, response_text, error, attempts FROM llm_requests WHERE id = $1`, [id]);
    const r = open(rows[0]);
    if (!r) return { ok: false, reason: 'missing', error: 'The request is gone.' };
    if (r.status === 'done') return { ok: true, text: r.response_text ?? '' };
    if (r.status === 'failed') return { ok: false, reason: 'failed', error: r.error || 'The worker could not write this.' };
    if (r.status === 'expired') return { ok: false, reason: 'expired', error: 'No worker answered in time.' };
    if (now() >= deadline) {
      await query(`UPDATE llm_requests SET status = 'expired' WHERE id = $1 AND status IN ('pending', 'claimed')`, [id]);
      return { ok: false, reason: 'expired', error: 'No worker answered in time.' };
    }
    await sleep(pollMs);
  }
}

/** Is any worker connected right now? */
export async function workerOnline(maxAgeMs = WORKER_ONLINE_MS) {
  const { rows } = await query(`SELECT 1 FROM llm_workers WHERE last_seen_at > now() - ($1::int * interval '1 millisecond') LIMIT 1`, [maxAgeMs]);
  return rows.length > 0;
}

export async function heartbeat(workerId, info = {}) {
  await query(
    `INSERT INTO llm_workers (worker_id, last_seen_at, info) VALUES ($1, now(), $2::jsonb)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at = now(), info = EXCLUDED.info`,
    [workerId, JSON.stringify(info || {})],
  );
}

/** Housekeeping, safe to run on every claim: requests nobody can use any more are closed, and a claim that went quiet goes back in the queue. */
export async function sweep() {
  await query(`UPDATE llm_requests SET status = 'expired' WHERE status IN ('pending', 'claimed') AND expires_at < now()`);
  await query(
    `UPDATE llm_requests SET status = 'pending', worker_id = NULL, claimed_at = NULL
      WHERE status = 'claimed' AND claimed_at < now() - ($1::int * interval '1 millisecond') AND attempts < $2 AND expires_at > now()`,
    [STALE_CLAIM_MS, MAX_ATTEMPTS],
  );
  await query(`UPDATE llm_requests SET status = 'failed', error = 'The worker did not answer after several attempts.'
                WHERE status = 'claimed' AND claimed_at < now() - ($1::int * interval '1 millisecond') AND attempts >= $2`, [STALE_CLAIM_MS, MAX_ATTEMPTS]);
  await query(`DELETE FROM llm_requests WHERE status IN ('done', 'failed', 'expired') AND created_at < now() - ($1::int * interval '1 day')`, [RETENTION_DAYS]);
}

/** The worker's side: takes up to `limit` waiting requests, oldest first. Two workers can never take the same one. */
export async function claimRequests(workerId, limit = 1) {
  const { rows } = await query(
    `UPDATE llm_requests SET status = 'claimed', worker_id = $1, claimed_at = now(), attempts = attempts + 1
      WHERE id IN (SELECT id FROM llm_requests WHERE status = 'pending' AND expires_at > now() ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, site_id, generator_id, system_text, user_text, options`,
    [workerId, Math.max(1, Math.min(limit, 5))],
  );
  return rows.map((r) => ({ id: r.id, siteId: r.site_id, generatorId: r.generator_id, system: r.system_text, user: r.user_text, options: r.options || {} }));
}

/** Records the worker's text. Only the worker that holds the claim can answer it. Returns false when it no longer holds it. */
export async function completeRequest(id, workerId, text) {
  if (typeof text !== 'string') return { ok: false, error: 'text must be a string' };
  if (text.length > MAX_RESPONSE_CHARS) return { ok: false, error: `the answer is ${text.length} characters, more than the ${MAX_RESPONSE_CHARS} the server accepts` };
  const { rowCount } = await query(
    `UPDATE llm_requests SET status = 'done', response_text = $3, completed_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'claimed'`,
    [id, workerId, text],
  );
  return { ok: rowCount > 0 };
}

/** The worker could not write it. `retryable` puts it back for another attempt (until MAX_ATTEMPTS); otherwise the caller is told it failed. */
export async function failRequest(id, workerId, error, { retryable = false } = {}) {
  const { rowCount } = retryable
    ? await query(`UPDATE llm_requests SET status = CASE WHEN attempts >= $4 THEN 'failed' ELSE 'pending' END, error = $3, worker_id = NULL, claimed_at = NULL WHERE id = $1 AND worker_id = $2 AND status = 'claimed'`, [id, workerId, String(error || '').slice(0, 500), MAX_ATTEMPTS])
    : await query(`UPDATE llm_requests SET status = 'failed', error = $3, completed_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'claimed'`, [id, workerId, String(error || '').slice(0, 500)]);
  return { ok: rowCount > 0 };
}

/** The worker is stopping: whatever it still holds goes back to the queue at once, without costing an attempt. */
export async function releaseRequests(workerId, ids = null) {
  const { rowCount } = await query(
    `UPDATE llm_requests SET status = 'pending', worker_id = NULL, claimed_at = NULL, attempts = GREATEST(attempts - 1, 0)
      WHERE worker_id = $1 AND status = 'claimed' AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))`,
    [workerId, ids],
  );
  return { released: rowCount };
}

/** For the dashboard and the daily report: what the queue looks like right now. */
export async function queueStatus() {
  const { rows } = await query(`SELECT status, count(*)::int n FROM llm_requests WHERE created_at > now() - interval '1 day' GROUP BY status`);
  const { rows: w } = await query(`SELECT count(*)::int n FROM llm_workers WHERE last_seen_at > now() - ($1::int * interval '1 millisecond')`, [WORKER_ONLINE_MS]);
  return { requests: Object.fromEntries(rows.map((r) => [r.status, r.n])), workersOnline: w[0]?.n ?? 0 };
}
