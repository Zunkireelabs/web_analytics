import { query } from '../db.js';

// Lean, append-only operational telemetry for the agentic tool-calling loop
// (agents/lib/agentic-orchestrator.js) — see server/migrations/042_agentic_orchestration_runs.sql.
// Deliberately carries no question text, narrative, or findings content.

export async function saveAgenticOrchestrationRun({
  siteId, mode, roundsUsed, toolCallsUsed, toolIdsUsed, promptTokens, completionTokens, tookMs,
}) {
  await query(
    `INSERT INTO agentic_orchestration_runs
       (site_id, mode, rounds_used, tool_calls_used, tool_ids_used, prompt_tokens, completion_tokens, took_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [siteId, mode, roundsUsed, toolCallsUsed, toolIdsUsed || [], promptTokens || 0, completionTokens || 0, tookMs]
  );
}

// Mirrors agent-runs.js's getAgentRunSummarySince() shape: lean aggregates,
// never full rows. "Average confidence" is deliberately not included — no
// confidence field exists anywhere on a finding/tool-result in this system.
export async function getAgenticOrchestrationStatsSince(siteId, sinceDate) {
  const [byModeResult, toolFrequencyResult, commonCombinationsResult] = await Promise.all([
    query(
      `SELECT mode, COUNT(*)::int AS sessions, AVG(rounds_used)::numeric(10,2) AS avg_rounds,
              AVG(tool_calls_used)::numeric(10,2) AS avg_tool_calls, AVG(took_ms)::int AS avg_took_ms
         FROM agentic_orchestration_runs WHERE site_id = $1 AND created_at >= $2 GROUP BY mode`,
      [siteId, sinceDate]
    ),
    query(
      `SELECT tool_id, COUNT(*)::int AS times_used FROM agentic_orchestration_runs, unnest(tool_ids_used) AS tool_id
        WHERE site_id = $1 AND created_at >= $2 GROUP BY tool_id ORDER BY times_used DESC`,
      [siteId, sinceDate]
    ),
    query(
      `SELECT tool_ids_used, COUNT(*)::int AS times_seen FROM agentic_orchestration_runs
        WHERE site_id = $1 AND created_at >= $2 AND array_length(tool_ids_used, 1) > 1
        GROUP BY tool_ids_used ORDER BY times_seen DESC LIMIT 10`,
      [siteId, sinceDate]
    ),
  ]);
  return { byMode: byModeResult.rows, toolFrequency: toolFrequencyResult.rows, commonCombinations: commonCombinationsResult.rows };
}
