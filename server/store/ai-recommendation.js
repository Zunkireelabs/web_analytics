import { query } from '../db.js';

// ai_tracked_prompts / ai_prompt_runs (migration 036). Same append-only,
// site_id-scoped conventions as every other agent's store module.

export async function listActivePrompts(siteId) {
  const { rows } = await query(
    `SELECT * FROM ai_tracked_prompts WHERE site_id = $1 AND active = true ORDER BY created_at ASC`,
    [siteId]
  );
  return rows;
}

// Idempotent — a prompt already tracked (same real text) is left alone
// rather than duplicated; only genuinely new prompts derived this run are
// inserted. `source` is not updated on conflict since the original
// derivation reason is the more meaningful one to keep.
export async function upsertTrackedPrompt(siteId, promptText, source) {
  const { rows } = await query(
    `INSERT INTO ai_tracked_prompts (site_id, prompt_text, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id, prompt_text) DO UPDATE SET active = true
     RETURNING *`,
    [siteId, promptText, source]
  );
  return rows[0];
}

// Last real check date per prompt id — feeds lib/rotation.js's
// sortByRotation the same way agent_page_rotation does for page-level
// agents, so prompts never-yet-checked go first, then least-recently-
// checked, instead of re-probing the same handful every run.
export async function getCheckedAtForPrompts(siteId, promptIds) {
  if (!promptIds.length) return new Map();
  const { rows } = await query(
    `SELECT prompt_id, MAX(created_at) AS checked_at
       FROM ai_prompt_runs
      WHERE site_id = $1 AND prompt_id = ANY($2)
      GROUP BY prompt_id`,
    [siteId, promptIds]
  );
  return new Map(rows.map((r) => [r.prompt_id, r.checked_at]));
}

export async function saveAiPromptRun(siteId, {
  promptId, model, runDate, rawResponse, mentioned, approximatePosition, competitorsMentioned, sentiment, recommendationStrength,
}) {
  const { rows } = await query(
    `INSERT INTO ai_prompt_runs (
       site_id, prompt_id, model, run_date, raw_response, mentioned,
       approximate_position, competitors_mentioned, sentiment, recommendation_strength
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      siteId, promptId, model, runDate, rawResponse, mentioned,
      approximatePosition ?? null, JSON.stringify(competitorsMentioned ?? []), sentiment ?? null, recommendationStrength ?? null,
    ]
  );
  return rows[0];
}

// Most recent real run per currently-active prompt — the read path for
// "AI Visibility %" trend/top-prompts/missed-prompts (one row per prompt,
// its latest check only, not full history).
export async function getLatestPromptRuns(siteId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (r.prompt_id) r.*, p.prompt_text, p.source
       FROM ai_prompt_runs r
       JOIN ai_tracked_prompts p ON p.id = r.prompt_id
      WHERE r.site_id = $1 AND p.active = true
      ORDER BY r.prompt_id, r.created_at DESC`,
    [siteId]
  );
  return rows;
}

// Real historical mention-rate trend (one point per real run_date this site
// has ever been checked) — feeds the dashboard sparkline, computed from
// actual persisted runs, never interpolated/estimated.
export async function getMentionRateHistory(siteId, limit = 12) {
  const { rows } = await query(
    `SELECT run_date,
            COUNT(*) FILTER (WHERE mentioned) AS mentioned_count,
            COUNT(*) AS total_count
       FROM ai_prompt_runs
      WHERE site_id = $1
      GROUP BY run_date
      ORDER BY run_date DESC
      LIMIT $2`,
    [siteId, limit]
  );
  return rows.reverse();
}

// Real mention-rate rolled up to calendar month, for a given date range —
// the read path for external monthly-cadence consumers (Data Analyst Agent
// MCP tool). Distinct from getMentionRateHistory above (per real run_date,
// most-recent-N) since a monthly series needs one point per month, not one
// per check.
export async function getMonthlyMentionRate(siteId, start, end) {
  const { rows } = await query(
    `SELECT to_char(date_trunc('month', run_date), 'YYYY-MM-DD') AS month,
            COUNT(*) FILTER (WHERE mentioned)::int AS mentioned_count,
            COUNT(*)::int AS total_count,
            ROUND((COUNT(*) FILTER (WHERE mentioned) * 100.0 / COUNT(*))::numeric, 2)::float8 AS visibility_pct
       FROM ai_prompt_runs
      WHERE site_id = $1 AND run_date BETWEEN $2 AND $3
      GROUP BY date_trunc('month', run_date)
      ORDER BY 1 ASC`,
    [siteId, start, end]
  );
  return rows;
}

// Real competitor mention counts aggregated across all runs in a given
// real date window — used to compare "this run" vs "last real check" so a
// finding like "Competitor X now appears more often" is a genuine
// before/after comparison, not a single-run snapshot presented as a trend.
export async function getCompetitorMentionCounts(siteId, sinceDate, beforeDate) {
  const { rows } = await query(
    `SELECT competitors_mentioned
       FROM ai_prompt_runs
      WHERE site_id = $1 AND run_date >= $2 AND run_date < $3`,
    [siteId, sinceDate, beforeDate]
  );
  const counts = new Map();
  for (const row of rows) {
    for (const name of (row.competitors_mentioned || [])) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return counts;
}
