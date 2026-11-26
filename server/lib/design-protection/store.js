// Database side of design protection (migration 272). Every function takes an optional `query` so tests run it without a database.
import { query as defaultQuery } from '../../db.js';

export const BASELINE_MAX_AGE_DAYS = () => Number(process.env.DESIGN_BASELINE_MAX_AGE_DAYS) || 30;

/** The baseline row for this project + template (never another project's, never another template's), or null. */
export async function getBaseline(siteId, templateKey, { query = defaultQuery } = {}) {
  const { rows } = await query(`SELECT * FROM design_baselines WHERE site_id = $1 AND template_key = $2`, [siteId, templateKey]);
  return rows[0] || null;
}

/** Pure. Is a stored row usable as a baseline right now? A reason is always given when it is not. */
export function baselineUsability(row, { now = new Date(), maxAgeDays = BASELINE_MAX_AGE_DAYS() } = {}) {
  if (!row) return { usable: false, reason: 'missing' };
  if (row.status === 'requested') return { usable: false, reason: 'capture-requested' };
  if (row.status === 'failed') return { usable: false, reason: 'capture-failed', detail: row.capture_error || null };
  if (row.status === 'unstable') return { usable: false, reason: 'unstable', detail: row.disagreements || null };
  if (row.status !== 'ready' || !row.tokens) return { usable: false, reason: 'not-ready' };
  const age = (now.getTime() - new Date(row.captured_at).getTime()) / 86_400_000;
  if (!(age <= maxAgeDays)) return { usable: false, reason: 'stale', detail: { ageDays: Math.round(age), maxAgeDays } };
  return { usable: true, reason: 'ready' };
}

/** Asks for a capture. Idempotent: an existing row that is already requested, or ready and fresh, is left alone. A failed/unstable/stale one is re-requested. */
export async function requestBaseline(siteId, templateKey, { query = defaultQuery } = {}) {
  const { rows } = await query(
    `INSERT INTO design_baselines (site_id, template_key, status) VALUES ($1, $2, 'requested')
     ON CONFLICT (site_id, template_key) DO UPDATE SET
       status = CASE WHEN design_baselines.status = 'ready' AND design_baselines.captured_at > now() - ($3::int * interval '1 day') THEN 'ready' ELSE 'requested' END,
       requested_at = CASE WHEN design_baselines.status = 'requested' THEN design_baselines.requested_at ELSE now() END,
       updated_at = now()
     RETURNING *`, [siteId, templateKey, BASELINE_MAX_AGE_DAYS()]);
  return rows[0];
}

export async function saveBaseline(siteId, templateKey, { status, tokens = null, patterns = null, vocabulary = null, sampleUrls = null, confidence = null, disagreements = null, error = null }, { query = defaultQuery } = {}) {
  const { rows } = await query(
    `INSERT INTO design_baselines (site_id, template_key, status, tokens, patterns, vocabulary, sample_urls, confidence, disagreements, capture_error, captured_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, CASE WHEN $3 IN ('ready', 'unstable') THEN now() ELSE NULL END)
     ON CONFLICT (site_id, template_key) DO UPDATE SET status = EXCLUDED.status, tokens = EXCLUDED.tokens, patterns = EXCLUDED.patterns, vocabulary = EXCLUDED.vocabulary,
       sample_urls = EXCLUDED.sample_urls, confidence = EXCLUDED.confidence, disagreements = EXCLUDED.disagreements, capture_error = EXCLUDED.capture_error,
       captured_at = CASE WHEN EXCLUDED.status IN ('ready', 'unstable') THEN now() ELSE design_baselines.captured_at END, updated_at = now()
     RETURNING *`,
    [siteId, templateKey, status, tokens && JSON.stringify(tokens), patterns && JSON.stringify(patterns), vocabulary && JSON.stringify(vocabulary), sampleUrls && JSON.stringify(sampleUrls), confidence, disagreements && JSON.stringify(disagreements), error]);
  return rows[0];
}

export async function listRequestedBaselines({ limit = 10 } = {}, { query = defaultQuery } = {}) {
  const { rows } = await query(`SELECT * FROM design_baselines WHERE status = 'requested' ORDER BY requested_at LIMIT $1`, [limit]);
  return rows;
}

/** Best effort, never throws: a decision that cannot be recorded must not be able to fail a ship (same contract as design_gate_decisions). */
export async function recordProtectionDecision(siteId, d, { query = defaultQuery } = {}) {
  try {
    await query(
      `INSERT INTO design_protection_decisions (site_id, draft_id, action_type, template_key, page_url, visible, verdict, mode, blocked, would_block, repaired, reasons, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)`,
      [siteId, d.draftId ?? null, d.actionType ?? null, d.templateKey ?? null, d.pageUrl ?? null, Boolean(d.visible), d.verdict, d.mode, Boolean(d.blocked), Boolean(d.wouldBlock), Boolean(d.repaired), JSON.stringify(d.reasons || []), JSON.stringify(d.evidence || {})]);
    return true;
  } catch (err) {
    console.warn(`[design-protection] could not record a decision for site ${siteId}: ${err.message}`);
    return false;
  }
}

/** What enforcing would do, per project, from the log-mode decisions: the read that decides whether it is safe to switch to enforce. */
export async function protectionSummary({ days = 7 } = {}, { query = defaultQuery } = {}) {
  const { rows } = await query(
    `SELECT site_id, verdict, count(*)::int AS n, count(*) FILTER (WHERE would_block)::int AS would_block
       FROM design_protection_decisions WHERE created_at > now() - ($1::int * interval '1 day') GROUP BY site_id, verdict ORDER BY site_id, n DESC`, [days]);
  return rows;
}
