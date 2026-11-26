// THE TOPIC DECISION LOG (migration 270 topic_decisions): every blog topic the system decided about, accepted or not, with the reasons, so a
// person can audit any choice. Writing is best effort and never throws into the caller: a failed log write must never stop a shipping run
// (the same rule as the run log and the day record).
import { query as defaultQuery } from '../../db.js';
import { cycleDateIn } from '../delivery-cycle.js';
import { topicKey } from '../content-index/normalize.js';

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
const jsonSafe = (v, maxChars = 200_000) => { const s = JSON.stringify(v ?? null); return s.length > maxChars ? JSON.stringify({ truncated: true, chars: s.length }) : s; };

/**
 * @param d { topic, decision: 'accepted'|'rejected'|'deferred', origin?, gates?, evidence?, relevance?, priority?, alternatives?, enforced?, recommendationId?, draftId? }
 * @returns the new row id, or null when the write failed
 */
export async function recordTopicDecision(siteId, d, { query = defaultQuery, timezone = 'Asia/Kathmandu', now = new Date(), dedupeToday = false } = {}) {
  try {
    if (!['accepted', 'rejected', 'deferred'].includes(d.decision)) throw new Error(`unknown decision "${d.decision}"`);
    // dedupeToday: the shipping passes run every 20+ minutes and re-evaluate the same open topics; one row per topic, decision and origin per day
    // keeps the log readable. The first row of the day wins (its gates and evidence are what the day's choice was based on).
    const { rows } = await query(
      `INSERT INTO topic_decisions (site_id, cycle_date, topic, topic_key, decision, origin, gates, evidence, relevance, priority, alternatives, enforced, recommendation_id, draft_id)
       SELECT $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13, $14
        WHERE NOT ($15::boolean AND EXISTS (SELECT 1 FROM topic_decisions x WHERE x.site_id = $1 AND x.cycle_date = $2 AND x.topic_key IS NOT DISTINCT FROM $4 AND x.decision = $5 AND x.origin = $6))
       RETURNING id`,
      [siteId, cycleDateIn(timezone, now), clip(d.topic, 400), topicKey(d.topic) || null, d.decision, clip(d.origin || 'gate', 40), jsonSafe(d.gates || []), jsonSafe(d.evidence || {}),
        d.relevance == null ? null : jsonSafe(d.relevance), d.priority ?? null, jsonSafe(d.alternatives || []), !!d.enforced, d.recommendationId ?? null, d.draftId ?? null, !!dedupeToday]);
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error(`[topic-decisions] site ${siteId}: could not record the decision for "${clip(d?.topic, 80)}":`, err.message);
    return null;
  }
}

export async function recordTopicDecisions(siteId, list, opts = {}) {
  const ids = [];
  for (const d of list) ids.push(await recordTopicDecision(siteId, d, opts));
  return ids;
}

/** Newest first. `day` (YYYY-MM-DD) and `decision` narrow it. */
export async function listTopicDecisions(siteId, { day = null, decision = null, origin = null, limit = 100, query = defaultQuery } = {}) {
  const { rows } = await query(
    `SELECT id, cycle_date, topic, decision, origin, gates, evidence, relevance, priority, alternatives, enforced, recommendation_id, draft_id, created_at
       FROM topic_decisions WHERE site_id = $1 AND ($2::date IS NULL OR cycle_date = $2::date) AND ($3::text IS NULL OR decision = $3) AND ($4::text IS NULL OR origin = $4)
      ORDER BY id DESC LIMIT $5`, [siteId, day, decision, origin, Math.min(Number(limit) || 100, 500)]);
  return rows;
}

/** What the last `days` decided, per decision, and why topics were turned away (counts by the first failing gate). */
export async function summarizeTopicDecisions(siteId, { days = 3, query = defaultQuery } = {}) {
  const { rows } = await query(
    `SELECT decision, count(*)::int n FROM topic_decisions WHERE site_id = $1 AND created_at > now() - ($2::int * interval '1 day') GROUP BY 1`, [siteId, days]);
  const { rows: why } = await query(
    `SELECT g->>'gate' AS gate, count(*)::int n FROM topic_decisions, jsonb_array_elements(gates) g
      WHERE site_id = $1 AND created_at > now() - ($2::int * interval '1 day') AND decision <> 'accepted' AND (g->>'ok')::boolean = false GROUP BY 1 ORDER BY 2 DESC`, [siteId, days]);
  return { byDecision: Object.fromEntries(rows.map((r) => [r.decision, r.n])), turnedAwayBecause: Object.fromEntries(why.map((r) => [r.gate, r.n])) };
}

/** A failed article whose content is kept (see blog-cycle/quarantine.js). */
export async function listQuarantinedArticles(siteId, { limit = 50, query = defaultQuery } = {}) {
  const { rows } = await query(
    `SELECT id, cycle_date, topic, gates, evidence, created_at FROM topic_decisions WHERE site_id = $1 AND origin = 'quarantine' ORDER BY id DESC LIMIT $2`, [siteId, Math.min(Number(limit) || 50, 200)]);
  return rows;
}

/** The newest earlier relevance verdict per topic key within `days` (accept or reject only; 'unknown' is never reused so it is retried). Saves a model call per topic per pass. */
export async function recentRelevanceVerdicts(siteId, topicKeys, { days = 14, query = defaultQuery } = {}) {
  const keys = [...new Set((topicKeys || []).filter(Boolean))];
  if (!keys.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (topic_key) topic_key, relevance FROM topic_decisions
      WHERE site_id = $1 AND topic_key = ANY($2::text[]) AND relevance IS NOT NULL AND relevance->>'verdict' IN ('accept', 'reject') AND created_at > now() - ($3::int * interval '1 day')
      ORDER BY topic_key, id DESC`, [siteId, keys, days]);
  return new Map(rows.map((r) => [r.topic_key, r.relevance]));
}
