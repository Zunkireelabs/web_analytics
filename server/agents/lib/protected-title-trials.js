import { PROTECTED_PAGE_REASON } from './protected-pages.js';

// The database and the recommendations store are loaded on first use, not at import: auto-remediation.js imports this
// module, and its tests replace those stores with partial fakes that a static import would break.
const db = () => import('../../db.js').then((m) => m.query);
const recs = () => import('../../store/recommendations.js').then((m) => m.insertRecommendation);

// Title changes on PROTECTED pages (pages that already earn clicks), shipped automatically within a weekly allowance and
// put back automatically when they measurably cost clicks. Owner's decision, 2026-11-18: "auto, with undo, max 3
// protected pages per client per week"; pull requests are still merged by a person.
//
//   allowance  At most PROTECTED_TITLE_WEEKLY_LIMIT title changes on protected pages per project in any 7 days.
//   record     Each one is stored with the title and description it replaced (protected_title_trials).
//   undo       When fix-impact.js measures the merged change (28 days before vs after, site-adjusted) as a SUPPORTED click
//              drop ('impact-negative'), a restore fix is queued: the same title generator, given the old title and
//              description, no model call. A drop inside ordinary noise is not a drop (fix-impact.js's own rules).
//   restores   A restore is never counted against the allowance and never blocked by protection or by the suppression
//              the bad measurement itself creates: putting back what was there is always allowed.

export const PROTECTED_TITLE_WEEKLY_LIMIT = Math.max(0, Number(process.env.PROTECTED_TITLE_WEEKLY_LIMIT ?? 3));
export const RESTORE_AGENT = 'protected-title-restore';

export const isRestore = (rec) => !!(rec?.params?.restore && typeof rec.params.restore === 'object');

/** A title fix held back ONLY because its page is protected (not blocked, not demoted, not another tier). */
export function isProtectedTitleCandidate(rec, decision) {
  return rec?.recommendation_type === 'meta-title' && decision?.reason === PROTECTED_PAGE_REASON;
}

export async function countTrialsThisWeek(siteId) {
  const query = await db();
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM protected_title_trials WHERE site_id = $1 AND shipped_at > now() - interval '7 days'`, [siteId]);
  return rows[0].n;
}

/**
 * Decides, for one run, which protected title fixes may ship. Pure apart from the count passed in.
 * Returns a predicate that lets through at most `remaining` of them (first come, in the order asked), plus restores always.
 */
export function makeAllowance(usedThisWeek, limit = PROTECTED_TITLE_WEEKLY_LIMIT) {
  let remaining = Math.max(0, limit - usedThisWeek);
  const granted = new Set();
  return {
    allow(rec, decision) {
      if (isRestore(rec) && rec.recommendation_type === 'meta-title') return true;
      if (!isProtectedTitleCandidate(rec, decision)) return false;
      if (remaining <= 0) return false;
      remaining--; granted.add(rec.id);
      return true;
    },
    granted,
    get remaining() { return remaining; },
  };
}

/** After a granted fix actually shipped (draft on the batch PR): remember what it replaced. Never throws. */
export async function recordTrial(siteId, rec, draft) {
  try {
    const query = await db();
    const c = draft?.content || {};
    const prev = c.previous || {};
    await query(
      `INSERT INTO protected_title_trials (site_id, recommendation_id, draft_id, page, query, previous_title, previous_description, new_title, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (draft_id) DO NOTHING`,
      [siteId, rec.id, draft.id, rec.params?.page || rec.page, c.query || rec.params?.query || null,
        prev.title || null, prev.description || null, c.selectedTitle || c.titles?.[0] || null,
        prev.title ? 'shipped' : 'not-restorable']
    );
  } catch (err) {
    console.error(`[protected-title] could not record trial for draft ${draft?.id}:`, err.message);
  }
}

/**
 * Called by fix-impact.js after a merged draft is measured. If the draft was a protected-page title trial: keep it, or
 * queue the restore when the verdict is a supported click drop. Returns what it did (for logs/tests). Never throws.
 */
export async function onTrialMeasured(draftId, verdict, deps = null) {
  try {
    deps ||= { query: await db(), insertRecommendation: await recs() };
    const { rows } = await deps.query(`SELECT * FROM protected_title_trials WHERE draft_id = $1 AND status = 'shipped'`, [draftId]);
    const t = rows[0];
    if (!t) return { action: 'none' };
    if (verdict !== 'impact-negative') {
      await deps.query(`UPDATE protected_title_trials SET status = 'kept', verdict = $2, decided_at = now() WHERE id = $1`, [t.id, verdict]);
      return { action: 'kept' };
    }
    const rec = await deps.insertRecommendation(t.site_id, {
      page: t.page,
      recommendationType: 'meta-title',
      issue: 'Put back the previous title: the automatic change measurably cost clicks',
      reason: `The title changed automatically on this page lost clicks over the 28 days after it went live (after allowing for the whole site's change), so the previous title and description are being restored.`,
      params: { page: t.page, query: t.query, restore: { title: t.previous_title, description: t.previous_description, ofDraftId: t.draft_id } },
      findingId: `${RESTORE_AGENT}:${t.draft_id}`,
      detectingAgent: RESTORE_AGENT,
      priority: 'high',
      riskTier: 'safe',
    });
    await deps.query(`UPDATE protected_title_trials SET status = 'restore-queued', verdict = $2, restore_recommendation_id = $3, decided_at = now() WHERE id = $1`, [t.id, verdict, rec?.id ?? null]);
    return { action: 'restore-queued', recommendationId: rec?.id ?? null };
  } catch (err) {
    console.error(`[protected-title] measurement follow-up failed for draft ${draftId}:`, err.message);
    return { action: 'error', error: err.message };
  }
}
