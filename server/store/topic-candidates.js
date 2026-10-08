import { query } from '../db.js';

// The scored topic queue (migration 185). Read by the content ship cycle,
// written by the topic scorer.
//
// Upsert, not append: the queue is the current answer to "what should we
// write next", not a log of every time cron asked. The score components
// stored beside each row are the audit trail, so overwriting a score does
// not lose the ability to explain the one before it — the components move
// with it.

// A row that was already SHIPPED is never pulled back into the queue by a
// re-score. The work exists; re-queueing it would mean a second page on the
// same topic, which is precisely the duplicate work the claims ledger and
// this queue exist to prevent.
export async function upsertTopicCandidate(siteId, c) {
  const { rows } = await query(
    `INSERT INTO topic_candidates
       (site_id, topic_key, topic, origin, sources_json, intent, score, components_json,
        demand_json, coverage_status, status, dropped_reason, scored_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (site_id, topic_key) DO UPDATE SET
       topic           = EXCLUDED.topic,
       sources_json    = EXCLUDED.sources_json,
       intent          = EXCLUDED.intent,
       score           = EXCLUDED.score,
       components_json = EXCLUDED.components_json,
       demand_json     = EXCLUDED.demand_json,
       coverage_status = EXCLUDED.coverage_status,
       status          = CASE WHEN topic_candidates.status = 'shipped' THEN 'shipped' ELSE EXCLUDED.status END,
       dropped_reason  = CASE WHEN topic_candidates.status = 'shipped' THEN topic_candidates.dropped_reason ELSE EXCLUDED.dropped_reason END,
       scored_at       = now()
     RETURNING id, status, score`,
    [
      siteId, c.topicKey, c.topic, c.origin, JSON.stringify(c.sources || []), c.intent || null,
      c.score ?? 0, JSON.stringify(c.components || {}),
      c.demand ? JSON.stringify(c.demand) : null,
      c.coverageStatus || null,
      c.dropped ? 'dropped' : 'queued',
      c.dropped || null,
    ]
  );
  return rows[0] || null;
}

// One statement for a whole batch. The scorer rescores every candidate each
// cycle, so a per-row round trip would be the dominant cost of a run.
export async function upsertTopicCandidates(siteId, candidates) {
  if (!candidates?.length) return 0;
  const cols = 12;
  const values = [];
  const params = [siteId];
  candidates.forEach((c, i) => {
    const b = i * cols + 1;
    values.push(`($1, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, now())`);
    params.push(
      c.topicKey, c.topic, c.origin, JSON.stringify(c.sources || []), c.intent || null,
      c.score ?? 0, JSON.stringify(c.components || {}),
      c.demand ? JSON.stringify(c.demand) : null,
      c.coverageStatus || null,
      c.dropped ? 'dropped' : 'queued',
      c.dropped || null,
    );
  });
  const { rowCount } = await query(
    `INSERT INTO topic_candidates
       (site_id, topic_key, topic, origin, sources_json, intent, score, components_json,
        demand_json, coverage_status, status, dropped_reason, scored_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (site_id, topic_key) DO UPDATE SET
       topic           = EXCLUDED.topic,
       sources_json    = EXCLUDED.sources_json,
       intent          = EXCLUDED.intent,
       score           = EXCLUDED.score,
       components_json = EXCLUDED.components_json,
       demand_json     = EXCLUDED.demand_json,
       coverage_status = EXCLUDED.coverage_status,
       status          = CASE WHEN topic_candidates.status = 'shipped' THEN 'shipped' ELSE EXCLUDED.status END,
       dropped_reason  = CASE WHEN topic_candidates.status = 'shipped' THEN topic_candidates.dropped_reason ELSE EXCLUDED.dropped_reason END,
       scored_at       = now()`,
    params
  );
  return rowCount;
}

// The ship cycle's own read: this site's queued topics, best first.
export async function listQueuedTopics(siteId, { limit = 10 } = {}) {
  const { rows } = await query(
    `SELECT id, topic_key, topic, origin, sources_json AS sources, intent, score,
            components_json AS components, demand_json AS demand, coverage_status, scored_at
       FROM topic_candidates
      WHERE site_id = $1 AND status = 'queued'
      ORDER BY score DESC, id ASC
      LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}

// Guarded so two concurrent ship cycles cannot both claim one topic — the
// UPDATE only matches a row still queued, and an empty result means the
// other cycle got there first. Same technique as the partial-unique-index
// claims in work-claims.js, expressed as a conditional update because the
// row already exists here.
export async function markTopicShipped(siteId, topicKey, { recommendationId = null } = {}) {
  const { rows } = await query(
    `UPDATE topic_candidates
        SET status = 'shipped', shipped_at = now(), recommendation_id = $3
      WHERE site_id = $1 AND topic_key = $2 AND status = 'queued'
      RETURNING id`,
    [siteId, topicKey, recommendationId]
  );
  return rows[0]?.id ?? null;
}

// The rows a previous cycle already wrote for these topics. This is how
// corroboration survives the two pipelines running on DIFFERENT crons:
// trend-radar writes its topics on its own cadence, the keyword ship cycle
// on another, and neither is in memory when the other runs. Without this
// read, "both trending and searched" could only ever be noticed when both
// happened to be in one batch — which is almost never.
export async function getTopicCandidatesByKeys(siteId, topicKeys) {
  if (!topicKeys?.length) return new Map();
  const { rows } = await query(
    `SELECT topic_key, topic, origin, sources_json AS sources, demand_json AS demand,
            coverage_status, status, score
       FROM topic_candidates
      WHERE site_id = $1 AND topic_key = ANY($2::text[])`,
    [siteId, topicKeys]
  );
  return new Map(rows.map((r) => [r.topic_key, r]));
}

export async function getTopicCandidate(siteId, topicKey) {
  const { rows } = await query(
    `SELECT id, topic_key, topic, origin, sources_json AS sources, intent, score,
            components_json AS components, demand_json AS demand, coverage_status, status,
            dropped_reason, scored_at, shipped_at, recommendation_id
       FROM topic_candidates
      WHERE site_id = $1 AND topic_key = $2`,
    [siteId, topicKey]
  );
  return rows[0] || null;
}

// For the console / an audit: everything considered this cycle, including
// what was dropped and why.
export async function listTopicCandidates(siteId, { limit = 100, status = null } = {}) {
  const { rows } = await query(
    `SELECT id, topic_key, topic, origin, sources_json AS sources, intent, score,
            components_json AS components, demand_json AS demand, coverage_status, status,
            dropped_reason, scored_at, shipped_at
       FROM topic_candidates
      WHERE site_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY score DESC, id ASC
      LIMIT $3`,
    [siteId, status, limit]
  );
  return rows;
}
