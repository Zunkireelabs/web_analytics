import { query } from '../db.js';

// Sources with a real page_url and a real, already-callable per-page
// deterministic recheck function: opportunity (recommendationsFor) and
// content-gap (contentGapsFor) — see agents/lib/fix-verification.js for the
// source-aware branching between them. ai-visibility's findings are
// structural/site-level (no comparable single-page recheck), and anything
// from country-intelligence (landing-page/translation) produces brand-new
// content with no resulting URL — those stay on the existing
// hasDraftSince() heuristic instead of a faked verification.
const VERIFIABLE_SOURCES = new Set(['opportunity', 'content-gap']);
// Exported so routes/action-center.js's checkDraftPrStatus knows which
// generator ids already get a real fix-verification recheck (and therefore
// already write to agent_fix_memory via fix-verification.js) — everything
// else falls back to PR-merge/abandon as its only available outcome signal.
export const VERIFIABLE_GENERATOR_IDS = new Set(['meta-title', 'faq', 'schema', 'internal-links']);

export function isVerifiableDraft(draft) {
  return VERIFIABLE_SOURCES.has(draft.source)
    && !!draft.finding_id
    && VERIFIABLE_GENERATOR_IDS.has(draft.action_type)
    && !!draft.input?.page;
}

const DEFAULT_DELAY_HOURS = Number(process.env.FIX_VERIFY_DELAY_HOURS) || 48;

export async function createPendingVerification(siteId, { watchlistItemId, findingId, draftId, pageUrl, generatorId, queryText, source, memoryRefId }) {
  const { rows } = await query(
    `INSERT INTO fix_verifications (site_id, watchlist_item_id, finding_id, draft_id, page_url, generator_id, query, source, memory_ref_id, verify_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + ($10 * interval '1 hour'))
     RETURNING *`,
    [siteId, watchlistItemId ?? null, findingId, draftId, pageUrl, generatorId, queryText ?? null, source ?? null, memoryRefId ?? null, DEFAULT_DELAY_HOURS]
  );
  return rows[0];
}

// Global, not per-site — due-ness here is per-row (verify_after), so there's
// no site-level "is it due" marker to check first.
export async function getDueVerifications(limit = 50) {
  const { rows } = await query(
    `SELECT * FROM fix_verifications WHERE outcome = 'pending' AND verify_after <= now()
     ORDER BY verify_after ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function recordVerificationOutcome(id, outcome, evidence) {
  const { rows } = await query(
    `UPDATE fix_verifications SET outcome = $2, evidence = $3, checked_at = now()
     WHERE id = $1 RETURNING *`,
    [id, outcome, JSON.stringify(evidence ?? null)]
  );
  return rows[0] || null;
}

// Every verification row for a site since a given date, newest first — the
// Review Report's (agents/lib/review-report.js) real "did fixes actually
// stick" summary. Global getDueVerifications above is for the scheduler;
// this is the per-site history read.
export async function getVerificationsForSite(siteId, sinceDate) {
  const { rows } = await query(
    `SELECT * FROM fix_verifications WHERE site_id = $1 AND created_at >= $2 ORDER BY created_at DESC`,
    [siteId, sinceDate]
  );
  return rows;
}

// Resolves the Watchlist item (if any) tied to this finding, for the same
// site — used at insert time so the later verification row already knows
// which watchlist item to reopen, without a second lookup. Returns null for
// findings that never qualified for the Watchlist (e.g. low priority).
export async function getWatchlistItemByFindingId(siteId, findingId) {
  const { rows } = await query(
    'SELECT id, status FROM watchlist_items WHERE site_id = $1 AND finding_id = $2',
    [siteId, findingId]
  );
  return rows[0] || null;
}
