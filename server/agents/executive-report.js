import { runOrchestration } from './orchestrator.js';
import { getAgent } from './registry.js';
import { saveAgentRun } from '../store/agent-runs.js';

export const meta = {
  id: 'executive-report',
  name: 'Executive Report Agent',
  description: 'Synthesizes every specialist agent into one growth summary.',
  category: 'meta',
  version: 5,
  // competitor-intelligence is deliberately excluded — it now runs on its
  // own independent MONTHLY cadence (server/job.js's
  // runCompetitorIntelligenceIfDue), not weekly: real competitor movement
  // takes real time to show up, and re-crawling competitor sites weekly is
  // both wasteful and impolite. Its findings still surface everywhere
  // Command Center/Action Center read RECOMMENDATION_AGENT_IDS — this
  // narrative just doesn't force a fresh competitor check every week.
  //
  // Every other DAILY_AGENT_IDS/WEEKLY_ONLY_AGENT_IDS entry (job.js) belongs
  // here — this list was caught silently drifting behind that set once
  // already (sitemap/trust-compliance/geo-signals/growth-queries were each
  // added to job.js's real scheduling on 2026-07-27/08-03/08-04/08-04 but
  // never added here), so the weekly narrative quietly stopped covering 4
  // real agents' findings even though they kept running and surfacing
  // everywhere else (Command Center/Action Center/Copilot). If you add a
  // new agent to RECOMMENDATION_AGENT_IDS, add it here too unless it's
  // monthly-cadence like competitor-intelligence.
  requires: ['query-intelligence', 'opportunity', 'country-intelligence', 'device-intelligence', 'ai-visibility', 'content-gap', 'technical-seo', 'security-headers', 'internal-linking', 'duplicate-content', 'accessibility', 'mobile-usability', 'sitemap', 'trust-compliance', 'geo-signals', 'growth-queries'],
};

// content-gap runs weekly-only (server/job.js's DAILY_AGENT_IDS deliberately
// excludes it now — real content-completeness gaps don't meaningfully shift
// day to day, so a weekly check matches the underlying signal instead of
// re-crawling every candidate page daily). This weekly report is its ONLY
// chance to persist a real agent_runs row. Every other sub-agent here
// already persists its own row daily via job.js's runDailyAgentAnalysisForSite,
// so persisting all 16 here would just create redundant daily-duplicate rows
// for those 14 — only content-gap gets the explicit write. (growth-queries is
// also weekly-only, but unlike content-gap it has its own dedicated weekly
// gate — job.js's runGrowthQueryDiscoveryIfDueForAllSites, persist:true — so
// it doesn't need this same special-case treatment.)
const WEEKLY_ONLY_AGENT_ID = 'content-gap';

// Thin config over the shared orchestrator (orchestrator.js) — this agent no
// longer hand-rolls its own fan-out + synthesis; it just tells the
// orchestrator which agents to run. persistSubAgentRuns stays false so
// running the executive report still doesn't write redundant agent_runs
// rows for the 11 daily agents, same intent as the original direct
// agent.run() calls.
export async function run(input) {
  const result = await runOrchestration({ ...input, agentIds: meta.requires, persistSubAgentRuns: false });

  const weeklyOnly = result.perAgent[WEEKLY_ONLY_AGENT_ID];
  if (weeklyOnly) {
    const agent = await getAgent(WEEKLY_ONLY_AGENT_ID);
    await saveAgentRun({
      siteId: input.siteId, agentId: WEEKLY_ONLY_AGENT_ID, agentVersion: agent?.meta?.version,
      input, status: weeklyOnly.status, facts: weeklyOnly.facts ?? null, narrative: weeklyOnly.narrative ?? null,
      error: weeklyOnly.status === 'error' ? (weeklyOnly.message || 'unknown error') : null, tookMs: null,
    }).catch((err) => console.error(`[agents] failed to persist ${WEEKLY_ONLY_AGENT_ID} run:`, err.message));
  }

  return {
    meta,
    status: 'ok',
    facts: {
      rangeStart: input.start,
      rangeEnd: input.end,
      sections: result.perAgent,       // per-sub-agent {status, facts, narrative, message} — report/executive-doc.js's weekly synthesis reads this
      topFindings: result.findings.slice(0, 3),
      findings: result.findings,
    },
    narrative: result.narrative,
    generatedAt: result.generatedAt,
  };
}
