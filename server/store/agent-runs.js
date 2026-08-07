import { query } from '../db.js';

// Append-only log for agent_runs — see server/migrations/010_agent_runs.sql
// for why this is insert-only rather than an upsert like daily_reports.

export async function saveAgentRun({ siteId, agentId, agentVersion, input, status, facts, narrative, error, tookMs }) {
  await query(
    `INSERT INTO agent_runs (site_id, agent_id, agent_version, input, status, facts, narrative, error, took_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      siteId, agentId, agentVersion,
      JSON.stringify(input ?? {}),
      status,
      facts != null ? JSON.stringify(facts) : null,
      narrative ?? null,
      error ?? null,
      tookMs ?? null,
    ]
  );
}

// The single most recent run per agent, for a given set of agent ids — used
// by the Action Center to build its recommendation list instantly from
// already-persisted data instead of re-running every agent on page load.
export async function getLatestAgentRuns(siteId, agentIds) {
  const { rows } = await query(
    `SELECT DISTINCT ON (agent_id) id, agent_id, agent_version, input, status, facts, narrative, error, took_ms, created_at
       FROM agent_runs
      WHERE site_id = $1 AND agent_id = ANY($2)
      ORDER BY agent_id, created_at DESC`,
    [siteId, agentIds]
  );
  return rows;
}

// Agent-agnostic read of each agent's latest persisted structured findings
// (see agents/types.js `Finding`) — the single shared path the orchestrator
// (live runs) and lib/insights.js (cached reads for Reports) both call, so
// "how to read a finding out of the DB" exists exactly once.
export async function getLatestFindings(siteId, agentIds) {
  const runs = await getLatestAgentRuns(siteId, agentIds);
  return runs
    .filter((r) => r.status === 'ok')
    .map((r) => ({
      agentId: r.agent_id,
      agentVersion: r.agent_version,
      summary: r.narrative,
      findings: r.facts?.findings || [],
      // Every batch-rotated agent's facts carries checkedPages (this run's
      // rotation batch) — lets recommendation auto-close tell "fixed" apart
      // from "page just wasn't in today's batch" (see security-headers.js
      // facts and recommendation-coordinator.js's closeStaleRecommendations
      // gating for the full story). null for agents that check every page
      // every run (no rotation), which keep the old close-on-absence rule.
      checkedPages: r.facts?.checkedPages || null,
      // technical-seo only: pages whose outbound links were actually
      // re-checked this run (crawlInternalLinks is capped independently of
      // the page batch above — a page can be in checkedPages without its
      // links having been re-crawled if the daily href cap was already hit).
      linkCrawlCheckedPages: r.facts?.linkCrawl?.checkedPages || null,
      // The date range that produced this run — callers that need to ground
      // a finding's recommendedAction (e.g. looking up a page's real query
      // before drafting a meta-title) need this, not just the findings.
      start: r.input?.start ?? null,
      end: r.input?.end ?? null,
      createdAt: r.created_at,
    }));
}

// Most recent runs across ALL given agents, newest first — the AI Command
// Center's "AI Activity" feed. Every row here is a real completed run
// (agent_id, took_ms, created_at already persisted by runner.js) — nothing
// is synthesized to make the feed look busier than it actually is.
export async function getRecentActivity(siteId, agentIds, limit = 12) {
  const { rows } = await query(
    `SELECT agent_id, agent_version, status, took_ms, created_at
       FROM agent_runs
      WHERE site_id = $1 AND agent_id = ANY($2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [siteId, agentIds, limit]
  );
  return rows;
}

export async function getAgentRunHistory(siteId, agentId, limit = 10) {
  const { rows } = await query(
    `SELECT id, agent_id, agent_version, status, facts, narrative, error, took_ms, created_at
       FROM agent_runs
      WHERE site_id = $1 AND agent_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [siteId, agentId, limit]
  );
  return rows;
}

// Per-agent run counts since a given date — a lean aggregate (not full rows)
// for the Review Report (agents/lib/review-report.js), which needs "how much
// real activity happened since onboarding" per agent, not every individual
// run's full facts blob.
export async function getAgentRunSummarySince(siteId, agentIds, sinceDate) {
  const { rows } = await query(
    `SELECT agent_id,
            COUNT(*)::int AS total_runs,
            COUNT(*) FILTER (WHERE status = 'ok')::int AS ok_runs,
            COUNT(*) FILTER (WHERE status != 'ok')::int AS error_runs,
            MAX(created_at) AS last_run_at
       FROM agent_runs
      WHERE site_id = $1 AND agent_id = ANY($2) AND created_at >= $3
      GROUP BY agent_id`,
    [siteId, agentIds, sinceDate]
  );
  return rows;
}
