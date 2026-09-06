// Read/write for recommendation_attempts (migration 139) — the durable
// "what have we already tried, and what happened" record behind a
// recommendation's lifecycle state.
//
// Keyed by finding_id rather than recommendation_id for every aggregate read.
// That is deliberate: a recommendation row is closed and re-opened as a NEW
// row whenever its dedup key is freed and the issue is detected again
// (store/recommendations.js — the dedup index is partial on status='open'),
// so counting attempts per recommendation_id would silently reset the history
// to zero every time exactly the thing we're trying to prevent happens. The
// finding_id survives that.
import { query } from '../db.js';
import { classifyAbandonReason } from '../lib/attempt-classification.js';

// Records one attempt outcome. Callers pass an already-classified
// retryPolicy/failureClass where they have a structured error; where all they
// have is the free-text reason (the reconciler reading drafts.abandoned_reason)
// they omit both and this classifies it once, here, at write time — so the
// verdict is stored as a fact rather than re-derived by every later reader.
export async function recordAttempt(siteId, {
  recommendationId, findingId, draftId, outcome, failureClass, retryPolicy, reason,
}) {
  let cls = failureClass ?? null;
  let policy = retryPolicy ?? null;
  if (outcome !== 'shipped' && policy === null) {
    const classified = classifyAbandonReason(reason);
    cls = cls ?? classified.failureClass;
    policy = classified.retryPolicy;
  }
  const { rows } = await query(
    `INSERT INTO recommendation_attempts
       (site_id, recommendation_id, finding_id, draft_id, outcome, failure_class, retry_policy, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [siteId, recommendationId ?? null, findingId ?? null, draftId ?? null, outcome, cls, policy, reason ?? null],
  );
  return rows[0];
}

// finding_id -> { attempts, itemDefectAttempts, lastOutcome, lastPolicy,
// lastReason, lastAt }. One query for the whole site: getRecommendations
// needs this for every card it renders, and doing it per-card is how a list
// endpoint turns into N+1 round trips.
//
// itemDefectAttempts is counted separately from attempts because only that
// subset means "the item itself keeps failing" — the same distinction
// countFailedAttemptsByFinding draws with its exclusion list, but drawn here
// from the stored classification instead of from prose.
export async function attemptSummaryByFinding(siteId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (finding_id)
            finding_id,
            outcome      AS last_outcome,
            retry_policy AS last_policy,
            reason       AS last_reason,
            created_at   AS last_at,
            COUNT(*)          OVER (PARTITION BY finding_id) AS attempts,
            COUNT(*) FILTER (WHERE retry_policy = 'item_defect')
                              OVER (PARTITION BY finding_id) AS item_defect_attempts
       FROM recommendation_attempts
      WHERE site_id = $1 AND finding_id IS NOT NULL
      ORDER BY finding_id, created_at DESC`,
    [siteId],
  );
  return new Map(rows.map((r) => [r.finding_id, {
    attempts: Number(r.attempts),
    itemDefectAttempts: Number(r.item_defect_attempts),
    lastOutcome: r.last_outcome,
    lastPolicy: r.last_policy,
    lastReason: r.last_reason,
    lastAt: r.last_at,
  }]));
}

// finding_id -> count of 'recovered' outcomes (migration 142) — how many
// times the system has already re-analyzed this finding against LIVE content
// and refreshed the recommendation's params, as opposed to blindly retrying
// the same generator against the same stale evidence again.
//
// This is the counter that turns ship-pacing's flat MAX_FAILED_ATTEMPTS cap
// into a moving target: lib/action-center-reconciler.js's autonomous-recovery
// pass raises the effective cap by MAX_FAILED_ATTEMPTS every time it uses one
// of these, so a finding gets several independently-evidenced attempts before
// NEEDS_HUMAN is ever considered, instead of stopping cold at the first
// stale-evidence plateau. Unwindowed, unlike countFailedAttemptsByFinding's
// 30-day window — a recovery cycle is a rare, deliberate escalation (bounded
// by MAX_RECOVERY_CYCLES), not routine attempt noise that should age out.
export async function countRecoveryCyclesByFinding(siteId) {
  const { rows } = await query(
    `SELECT finding_id, COUNT(*)::int AS cycles
       FROM recommendation_attempts
      WHERE site_id = $1 AND finding_id IS NOT NULL AND outcome = 'recovered'
      GROUP BY finding_id`,
    [siteId],
  );
  return new Map(rows.map((r) => [r.finding_id, r.cycles]));
}

// The full history behind one card, oldest first — what the Action Center
// shows when a user asks "why does this keep coming back".
export async function listAttemptsForRecommendation(siteId, recommendationId, findingIds = []) {
  const { rows } = await query(
    `SELECT * FROM recommendation_attempts
      WHERE site_id = $1
        AND (recommendation_id = $2 OR ($3::text[] IS NOT NULL AND finding_id = ANY($3)))
      ORDER BY created_at ASC`,
    [siteId, recommendationId, findingIds.length ? findingIds : null],
  );
  return rows;
}
