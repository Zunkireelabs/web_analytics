// A cross-process, cross-host lease lock backed by job_locks (migration 147),
// not a Postgres advisory lock — see that migration's own comment for why
// (Supavisor's transaction-pooling mode makes session locks unreliable and
// transaction locks too expensive for an hours-long job).
//
// Built for the concrete failure on 2026-09-08: the laptop dev server and
// the VPS staging container both ran the same site's 07:00 job minutes
// apart against the same database and the same GitHub App token, doubling
// the API calls a single run makes and exhausting the token mid-batch. This
// makes the second scheduler find the lock held and skip its turn instead.
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';

// How long a lease is granted before it's considered abandoned. Long enough
// that a normal heartbeat (see withJobLock below) always renews it well
// before expiry; short enough that a hard-killed process (a laptop closed
// mid-run, a container OOM-killed) frees the job for the next scheduled
// attempt on the same day rather than starving it until tomorrow.
const LEASE_MS = 15 * 60 * 1000;

// How often a long-running holder renews its lease. A third of LEASE_MS, so
// a single missed heartbeat (a slow GC pause, a transient DB hiccup) still
// leaves two more chances to renew before the lease actually expires.
const HEARTBEAT_MS = 5 * 60 * 1000;

export function jobKeyFor(jobName, siteId) {
  return `${jobName}:${siteId}`;
}

// Atomic: the INSERT wins outright when no row exists, and ON CONFLICT only
// overwrites a row whose expires_at has already passed — a live holder's row
// never matches the WHERE clause, so a concurrent caller's UPDATE is a
// no-op and RETURNING reports nothing back to it. That is the whole lock in
// one round trip; there is no separate SELECT to race against.
async function tryAcquire(jobKey, ownerId, leaseMs) {
  const { rows } = await query(
    `INSERT INTO job_locks (job_key, owner_id, acquired_at, heartbeat_at, expires_at)
     VALUES ($1, $2, now(), now(), now() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (job_key) DO UPDATE
       SET owner_id = EXCLUDED.owner_id, acquired_at = now(), heartbeat_at = now(), expires_at = EXCLUDED.expires_at
       WHERE job_locks.expires_at < now()
     RETURNING owner_id`,
    [jobKey, ownerId, leaseMs],
  );
  return rows[0]?.owner_id === ownerId;
}

async function heartbeat(jobKey, ownerId, leaseMs) {
  await query(
    `UPDATE job_locks SET heartbeat_at = now(), expires_at = now() + ($3 || ' milliseconds')::interval
     WHERE job_key = $1 AND owner_id = $2`,
    [jobKey, ownerId, leaseMs],
  );
}

async function release(jobKey, ownerId) {
  await query(`DELETE FROM job_locks WHERE job_key = $1 AND owner_id = $2`, [jobKey, ownerId]);
}

// Runs `fn` only while holding the lease for `jobKey`; returns
// { ran: false, reason: 'locked' } without calling fn at all if another
// process already holds it. The lease is renewed on a timer for the
// duration of fn and always released (or left to expire, if the process is
// killed) once fn settles — success or throw.
export async function withJobLock(jobKey, fn, { leaseMs = LEASE_MS, heartbeatMs = HEARTBEAT_MS } = {}) {
  const ownerId = `${process.pid}:${randomUUID().slice(0, 8)}`;
  const acquired = await tryAcquire(jobKey, ownerId, leaseMs);
  if (!acquired) return { ran: false, reason: 'locked' };

  const timer = setInterval(() => {
    heartbeat(jobKey, ownerId, leaseMs).catch((err) => {
      console.error(`[job-lock] heartbeat failed for ${jobKey}:`, err.message);
    });
  }, heartbeatMs);
  // A dev/test process exiting must not hang on this timer.
  timer.unref?.();

  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    clearInterval(timer);
    await release(jobKey, ownerId).catch((err) => {
      console.error(`[job-lock] release failed for ${jobKey} (will expire naturally):`, err.message);
    });
  }
}
