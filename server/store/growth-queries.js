import { query } from '../db.js';

// tracked_growth_queries / growth_query_status / growth_query_checks
// (migration 077). Same append-only-history + site_id-scoped conventions as
// server/store/ai-recommendation.js.

// Idempotent — a query already tracked (same real text) bumps last_seen_at
// rather than being duplicated; query_type/source are not updated on
// conflict since the original derivation reason is the more meaningful one
// to keep. Callers can tell "new this cycle" from a row whose
// first_seen_at === last_seen_at after this call.
export async function upsertTrackedQuery(siteId, queryText, queryType, source) {
  const { rows } = await query(
    `INSERT INTO tracked_growth_queries (site_id, query_text, query_type, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, query_text) DO UPDATE SET active = true, last_seen_at = now()
     RETURNING *`,
    [siteId, queryText, queryType, source]
  );
  return rows[0];
}

export async function listActiveQueries(siteId) {
  const { rows } = await query(
    `SELECT * FROM tracked_growth_queries WHERE site_id = $1 AND active = true ORDER BY first_seen_at ASC`,
    [siteId]
  );
  return rows;
}

export async function getQueryStatus(siteId, queryIds) {
  if (!queryIds.length) return new Map();
  const { rows } = await query(
    `SELECT * FROM growth_query_status WHERE site_id = $1 AND query_id = ANY($2)`,
    [siteId, queryIds]
  );
  return new Map(rows.map((r) => [r.query_id, r]));
}

export async function upsertQueryStatus(siteId, queryId, { coverageStatus, coveredByPage, incumbentNote, draftedAt }) {
  const { rows } = await query(
    `INSERT INTO growth_query_status (site_id, query_id, coverage_status, covered_by_page, incumbent_note, last_checked_at, drafted_at)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (site_id, query_id) DO UPDATE SET
       coverage_status = EXCLUDED.coverage_status,
       covered_by_page = EXCLUDED.covered_by_page,
       incumbent_note = EXCLUDED.incumbent_note,
       last_checked_at = now(),
       drafted_at = COALESCE(growth_query_status.drafted_at, EXCLUDED.drafted_at)
     RETURNING *`,
    [siteId, queryId, coverageStatus, coveredByPage ?? null, incumbentNote ?? null, draftedAt ?? null]
  );
  return rows[0];
}

// Marks a query as drafted (a direct-answer generator has produced content
// for it) — separate from upsertQueryStatus's coverage write so
// Phase 3 (drafting) can stamp this without re-running Phase 2's coverage
// check first.
export async function markQueryDrafted(siteId, queryId) {
  await query(
    `UPDATE growth_query_status SET drafted_at = now() WHERE site_id = $1 AND query_id = $2`,
    [siteId, queryId]
  );
}

// Last real check date per query id, across both check types — feeds
// lib/rotation.js's sortByRotation the same way ai-recommendation's
// getCheckedAtForPrompts does, so queries never-yet-checked go first.
export async function getCheckedAtForQueries(siteId, queryIds) {
  if (!queryIds.length) return new Map();
  const { rows } = await query(
    `SELECT query_id, MAX(checked_at) AS checked_at
       FROM growth_query_checks
      WHERE site_id = $1 AND query_id = ANY($2)
      GROUP BY query_id`,
    [siteId, queryIds]
  );
  return new Map(rows.map((r) => [r.query_id, r.checked_at]));
}

export async function recordGrowthQueryCheck(siteId, queryId, { checkType, found, position, detail }) {
  const { rows } = await query(
    `INSERT INTO growth_query_checks (site_id, query_id, check_type, found, position, detail)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [siteId, queryId, checkType, found ?? null, position ?? null, JSON.stringify(detail ?? null)]
  );
  return rows[0];
}

// Real queries a direct-answer draft has already been generated for —
// Phase 5's verification rotation pool. Joins tracked_growth_queries for the
// real query text since growth_query_checks/ai_tracked_prompts only ever
// store the query id.
export async function listDraftedQueries(siteId) {
  const { rows } = await query(
    `SELECT s.query_id, s.coverage_status, s.drafted_at, q.query_text
       FROM growth_query_status s
       JOIN tracked_growth_queries q ON q.id = s.query_id
      WHERE s.site_id = $1 AND s.drafted_at IS NOT NULL AND q.active = true`,
    [siteId]
  );
  return rows;
}

// Latest real AI-mention result per growth query, read from
// ai-recommendation.js's OWN already-probed ai_prompt_runs via the
// growth_query_id link (migration 077) — this file never probes an AI
// provider itself, it only reads what that agent's own cron cycle already
// recorded, so Phase 5's AI-mention check has zero duplicate probing cost.
export async function getLatestAiMentionForQueries(siteId, queryIds) {
  if (!queryIds.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (p.growth_query_id) p.growth_query_id, r.mentioned, r.created_at
       FROM ai_tracked_prompts p
       JOIN ai_prompt_runs r ON r.prompt_id = p.id
      WHERE p.site_id = $1 AND p.growth_query_id = ANY($2)
      ORDER BY p.growth_query_id, r.created_at DESC`,
    [siteId, queryIds]
  );
  return new Map(rows.map((r) => [r.growth_query_id, { mentioned: r.mentioned, checkedAt: r.created_at }]));
}

// Most recent real check per query, for a given check_type — the read path
// for "did this query flip not-found -> found since we drafted for it."
export async function getRecentChecks(siteId, queryIds, checkType, limit = 2) {
  if (!queryIds.length) return new Map();
  const { rows } = await query(
    `SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY query_id ORDER BY checked_at DESC) AS rn
          FROM growth_query_checks
         WHERE site_id = $1 AND query_id = ANY($2) AND check_type = $3
     ) ranked
     WHERE rn <= $4
     ORDER BY query_id, checked_at DESC`,
    [siteId, queryIds, checkType, limit]
  );
  const byQuery = new Map();
  for (const row of rows) {
    if (!byQuery.has(row.query_id)) byQuery.set(row.query_id, []);
    byQuery.get(row.query_id).push(row);
  }
  return byQuery;
}
