import { createHash } from 'node:crypto';
import { query } from '../db.js';
import { AUTONOMOUS_DRAFT_SOURCES } from '../lib/autonomous-quota.js';

// CRUD and the state machine for the shared autonomous shipping queue
// (migration 148). See that file for what the queue is for; this module is
// only concerned with making every transition safe to repeat.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: every write is idempotent, and
// every claim is reversible. A deployment, a crashed worker, a duplicated
// cron, an LLM timeout or a GitHub outage can land between any two
// statements here, and the next pass must be able to work out what already
// happened from the row alone — never by re-doing the expensive half and
// hoping it converges.

export const QUEUE_STATES = Object.freeze({
  QUEUED: 'queued',
  PREPARING: 'preparing',
  PREPARED: 'prepared',
  SHIPPING: 'shipping',
  SHIPPED: 'shipped',
  FAILED: 'failed',
  SUPERSEDED: 'superseded',
});

// States in which an item is still "live work" — the set the partial unique
// index in migration 148 uses, kept in sync here because the dedupe contract
// is a property of both halves together.
const ACTIVE_STATES = [QUEUE_STATES.QUEUED, QUEUE_STATES.PREPARING, QUEUE_STATES.PREPARED, QUEUE_STATES.SHIPPING];

/**
 * Stable identity for one piece of work.
 *
 * The finding id is used whenever there is one, because that is what the
 * whole rest of the platform already treats as "the same problem" (drafts,
 * recommendation-coordinator, fix verification). Only when a producer has no
 * finding — content-repair's whole-site sweep, a design-agent template
 * refresh — does this fall back to hashing the generator and its params, so
 * two hourly passes that computed the same intent collapse to one row
 * instead of racing each other into the same batch.
 */
export function dedupeKeyFor({ source, generatorId, findingId, params, kind = 'draft' }) {
  if (findingId) return `finding:${findingId}`;
  const payload = JSON.stringify({ kind, generatorId: generatorId || null, params: params || {} });
  return `${kind}:${source}:${generatorId || 'none'}:${createHash('sha1').update(payload).digest('hex').slice(0, 16)}`;
}

/**
 * Record the intent to ship something. Safe to call as often as a producer
 * likes: a row already active for the same (site, dedupe key) is returned
 * unchanged rather than duplicated, which is what lets an hourly discovery
 * pass simply re-enqueue everything it can still see instead of maintaining
 * its own "have I already told the queue about this" bookkeeping.
 *
 * @returns {{ row, created: boolean }}
 */
export async function enqueue(siteId, {
  source, lane = 'analytics', kind = 'draft', generatorId = null,
  recommendationId = null, findingId = null, params = {}, score = null,
  // learned-repair.js's agent_fix_memory row this item borrows its fix from
  // (see that module's cross-site safety boundary comment) — kept distinct
  // from `params` because it describes PROVENANCE, not a generator input,
  // and the shipping run needs it back to record recordFixOutcome against
  // the right memory row once the item actually ships or fails.
  memoryRefId = null,
}) {
  if (!source) throw new Error('shipping-queue: source is required');
  if (!AUTONOMOUS_DRAFT_SOURCES.includes(source)) {
    // Not a style rule: an unlisted source is one the daily ceiling does not
    // count, so admitting it here would silently reintroduce exactly the
    // uncounted lane this queue was built to end.
    throw new Error(`shipping-queue: "${source}" is not an autonomous shipping source — add it to AUTONOMOUS_DRAFT_SOURCES if it should draw from the daily ceiling`);
  }
  const dedupeKey = dedupeKeyFor({ source, generatorId, findingId, params, kind });

  const { rows } = await query(
    `INSERT INTO shipping_queue (site_id, source, lane, kind, generator_id, recommendation_id, finding_id, params, score, dedupe_key, memory_ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [siteId, source, lane, kind, generatorId, recommendationId, findingId, JSON.stringify(params || {}), score, dedupeKey, memoryRefId]
  );
  if (rows[0]) return { row: rows[0], created: true };

  const { rows: existing } = await query(
    `SELECT * FROM shipping_queue
      WHERE site_id = $1 AND dedupe_key = $2 AND state = ANY($3)
      ORDER BY id DESC LIMIT 1`,
    [siteId, dedupeKey, ACTIVE_STATES]
  );
  return { row: existing[0] || null, created: false };
}

export async function listByState(siteId, state, { limit = 500 } = {}) {
  const states = Array.isArray(state) ? state : [state];
  const { rows } = await query(
    `SELECT * FROM shipping_queue
      WHERE site_id = $1 AND state = ANY($2)
      ORDER BY score DESC NULLS LAST, id ASC
      LIMIT $3`,
    [siteId, states, limit]
  );
  return rows;
}

export async function getQueueItem(id) {
  const { rows } = await query('SELECT * FROM shipping_queue WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * Take ownership of queued items for a preparation pass.
 *
 * The state change and the selection happen in ONE statement so two
 * preparation workers (the laptop dev server and the staging container, the
 * real 2026-09-08 pairing that motivated job_locks) can never both claim the
 * same row: the second one's UPDATE simply matches nothing.
 */
export async function claimForPreparation(siteId, { limit = 25, workerId = 'preparation' } = {}) {
  const { rows } = await query(
    `UPDATE shipping_queue SET state = $4, claimed_at = now(), claimed_by = $5, attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM shipping_queue
         WHERE site_id = $1 AND state = $2
         ORDER BY score DESC NULLS LAST, id ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [siteId, QUEUE_STATES.QUEUED, limit, QUEUE_STATES.PREPARING, workerId]
  );
  return rows;
}

/**
 * A real, validated draft now exists for this item.
 *
 * `draftId` is what makes recovery cheap: a pass that crashes after this
 * point finds the row already prepared and reuses the draft rather than
 * paying for generation again.
 */
export async function markPrepared(id, { draftId, filePaths = [], score = null }) {
  const { rows } = await query(
    `UPDATE shipping_queue
        SET state = $2, draft_id = $3, file_paths = $4, prepared_at = now(),
            score = COALESCE($5, score), claimed_at = NULL, claimed_by = NULL,
            last_error = NULL, updated_at = now()
      WHERE id = $1 AND state <> $6
      RETURNING *`,
    [id, QUEUE_STATES.PREPARED, draftId ?? null, filePaths, score, QUEUE_STATES.SHIPPED]
  );
  return rows[0] || null;
}

/**
 * Claim prepared items for one shipping batch.
 *
 * `batchId` is the branch name the batch will push, so a run interrupted
 * between claiming and finalizing leaves rows that name the exact branch to
 * reconcile against — which is what lib/batch-pr-recovery.js needs to finish
 * a batch whose commits landed but whose PR never opened, without redrafting.
 */
export async function claimForShipping(siteId, ids, batchId) {
  if (!ids?.length) return [];
  const { rows } = await query(
    `UPDATE shipping_queue
        SET state = $4, batch_id = $5, claimed_at = now(), updated_at = now()
      WHERE site_id = $1 AND id = ANY($2) AND state = $3
      RETURNING *`,
    [siteId, ids, QUEUE_STATES.PREPARED, QUEUE_STATES.SHIPPING, batchId]
  );
  return rows;
}

export async function markShipped(id) {
  const { rows } = await query(
    `UPDATE shipping_queue SET state = $2, shipped_at = now(), claimed_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, QUEUE_STATES.SHIPPED]
  );
  return rows[0] || null;
}

/**
 * Hand an item back to the queue.
 *
 * `retryable` is the whole point of the distinction: a GitHub outage or a
 * rate-limit exhaustion is not evidence about the WORK, so the item returns
 * to 'prepared' with its draft intact and ships tomorrow with no
 * regeneration. A generator that refused, or content that failed its gates,
 * is evidence about the work and goes to 'failed'.
 */
export async function releaseItem(id, { retryable, error = null }) {
  // A retryable release keeps whatever work already exists: an item that had
  // reached a real draft returns to 'prepared' (tomorrow ships it as-is, no
  // second generation), one that had not returns to 'queued' for another
  // preparation attempt. Expressed in SQL rather than read-then-write so a
  // concurrent finalize can't slip between the two.
  const { rows } = await query(
    `UPDATE shipping_queue
        SET state = CASE
                      WHEN $2::boolean IS NOT TRUE THEN $3
                      WHEN draft_id IS NULL THEN $4
                      ELSE $5
                    END,
            last_error = $6, batch_id = NULL, claimed_at = NULL, claimed_by = NULL, updated_at = now()
      WHERE id = $1 AND state <> $7
      RETURNING *`,
    [id, Boolean(retryable), QUEUE_STATES.FAILED, QUEUE_STATES.QUEUED, QUEUE_STATES.PREPARED, error, QUEUE_STATES.SHIPPED]
  );
  return rows[0] || null;
}

export async function markSuperseded(id, reason = null) {
  const { rows } = await query(
    `UPDATE shipping_queue SET state = $2, last_error = $3, claimed_at = NULL, updated_at = now()
      WHERE id = $1 AND state = ANY($4) RETURNING *`,
    [id, QUEUE_STATES.SUPERSEDED, reason, ACTIVE_STATES]
  );
  return rows[0] || null;
}

/**
 * Return rows whose worker died mid-claim to the state before the claim.
 *
 * Restart-safety in one statement. A 'preparing' row whose worker vanished
 * has no draft and goes back to 'queued'; a 'shipping' row keeps whatever
 * draft it already had and goes back to 'prepared', so an interrupted batch
 * resumes at the shipping step rather than regenerating everything it had
 * already paid to build.
 */
export async function releaseStaleClaims({ olderThanMinutes = 90 } = {}) {
  const { rows } = await query(
    `UPDATE shipping_queue
        SET state = CASE WHEN state = $1 THEN (CASE WHEN draft_id IS NULL THEN $2 ELSE $3 END) ELSE $3 END,
            claimed_at = NULL, claimed_by = NULL, batch_id = NULL, updated_at = now()
      WHERE state IN ($1, $4)
        AND claimed_at IS NOT NULL
        AND claimed_at < now() - ($5 || ' minutes')::interval
      RETURNING *`,
    [QUEUE_STATES.PREPARING, QUEUE_STATES.QUEUED, QUEUE_STATES.PREPARED, QUEUE_STATES.SHIPPING, String(olderThanMinutes)]
  );
  return rows;
}

/**
 * How much this site has already shipped today, in ITS OWN timezone.
 *
 * Counted from the queue rather than from `drafts` because the queue is the
 * only place that sees every lane — including content-repair, which ships
 * file edits and never creates a draft row at all. A ceiling that could not
 * see that lane is the ceiling that was not a ceiling.
 */
export async function countShippedToday(siteId, timezone = 'UTC') {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM shipping_queue
      WHERE site_id = $1 AND state = $2 AND shipped_at IS NOT NULL
        AND (shipped_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date`,
    [siteId, QUEUE_STATES.SHIPPED, timezone]
  );
  return rows[0]?.n ?? 0;
}

/** Platform-wide sibling of countShippedToday — UTC, for the global ceiling. */
export async function countShippedTodayAllSites() {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM shipping_queue
      WHERE state = $1 AND shipped_at IS NOT NULL
        AND (shipped_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`,
    [QUEUE_STATES.SHIPPED]
  );
  return rows[0]?.n ?? 0;
}

/**
 * How much file-edits work (content-repair, template-capability-repair) this
 * site has shipped today, in ITS OWN timezone.
 *
 * Scoped to `kind = 'file-edits'` specifically, not every shipped row: a
 * `kind = 'draft'` item (learned-repair) is shipped THROUGH
 * shipDraftForRecommendation, which also writes a real `drafts` row that
 * countDraftsBySourcesToday already counts — summing this function's
 * unfiltered sibling (countShippedToday) into that count would count the
 * same fix twice. `kind = 'file-edits'` items never create a `drafts` row at
 * all (see repair-site-content-live.js / repair-template-capability.js), so
 * this is the one slice of the queue the drafts-based count can never see.
 */
export async function countShippedFileEditsToday(siteId, timezone = 'UTC') {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM shipping_queue
      WHERE site_id = $1 AND state = $2 AND kind = 'file-edits' AND shipped_at IS NOT NULL
        AND (shipped_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date`,
    [siteId, QUEUE_STATES.SHIPPED, timezone]
  );
  return rows[0]?.n ?? 0;
}

/** Platform-wide sibling of countShippedFileEditsToday — UTC, for the global ceiling. */
export async function countShippedFileEditsTodayAllSites() {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM shipping_queue
      WHERE state = $1 AND kind = 'file-edits' AND shipped_at IS NOT NULL
        AND (shipped_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`,
    [QUEUE_STATES.SHIPPED]
  );
  return rows[0]?.n ?? 0;
}

/** Items already claimed by a batch that never finished — the recovery entry point. */
export async function listInFlightBatchItems(siteId, batchId) {
  const { rows } = await query(
    'SELECT * FROM shipping_queue WHERE site_id = $1 AND batch_id = $2 AND state = $3 ORDER BY id',
    [siteId, batchId, QUEUE_STATES.SHIPPING]
  );
  return rows;
}
