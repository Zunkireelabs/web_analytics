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

// This agent's own status, derived from what its sub-agents actually did.
//
// It used to be a hardcoded `status: 'ok'`. runOrchestration never throws —
// orchestrator.js catches per agent and records status:'error' in perAgent —
// so when the DB or the fetch/LLM path was down and all 16 required
// sub-agents failed, this still persisted an agent_runs row reading
// status:'ok' with zero findings. Every surface that reads that row then
// reported the most reassuring possible version of a total outage:
// command-center.js maps the executive-report row's status straight onto
// `analysisStatus` ('ok' -> 'complete'), and report/executive-doc.js's
// weekly Google Doc synthesises "nothing found this week" from empty
// sections. This is the top-level meta-agent, so that one wrong literal
// masked failure system-wide.
//
// The three-way split is chosen to match the one real consumer's own
// vocabulary rather than invented here — command-center.js already reads
// 'ok' -> complete / 'insufficient-data' -> partial / anything else ->
// error, and agents/types.js defines exactly those three statuses:
//   - every sub-agent errored  -> 'error'. Nothing was measured; this is an
//     outage, not a clean run.
//   - some errored             -> 'insufficient-data'. The findings we do
//     have are real and worth keeping (facts stays populated below), but the
//     picture is incomplete and must not read as "complete".
//   - none errored             -> 'ok'. A sub-agent's own
//     'insufficient-data' is an honest abstention (no GSC data yet, no
//     PageSpeed key), not a failure, so it does NOT downgrade this agent —
//     otherwise a brand-new site would permanently show as broken.
export function orchestrationStatus(perAgent, agentIds) {
  const statuses = agentIds.map((id) => perAgent?.[id]?.status ?? 'error'); // a required agent missing from perAgent entirely never ran — count it as failed, not as passing
  const failed = agentIds.filter((id, i) => statuses[i] === 'error');
  if (!failed.length) return { status: 'ok', message: null, failedAgentIds: [] };
  const status = failed.length === agentIds.length ? 'error' : 'insufficient-data';
  const message = failed.length === agentIds.length
    ? `Every specialist agent failed this run (${failed.length}) — this report reflects an outage, not a clean result.`
    : `${failed.length} of ${agentIds.length} specialist agents failed this run (${failed.join(', ')}) — this report is incomplete.`;
  return { status, message, failedAgentIds: failed };
}

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

  const { status, message, failedAgentIds } = orchestrationStatus(result.perAgent, meta.requires);

  // facts stays populated even when status !== 'ok', deliberately departing
  // from types.js's "facts is null unless ok" note: report/executive-doc.js
  // reads agentOutput.facts.sections unconditionally to build the weekly Doc,
  // and its prompt already instructs the model to name an errored section as
  // a gap rather than guessing around it. Nulling facts here would turn a
  // partial run into a crash and lose the sub-agent results that DID succeed.
  return {
    meta,
    status,
    ...(message ? { message } : {}),
    facts: {
      failedAgentIds, // real ids, so the Doc/UI can name what's missing instead of reading an empty findings list as "nothing wrong"
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
