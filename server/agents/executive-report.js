import { runOrchestration } from './orchestrator.js';

export const meta = {
  id: 'executive-report',
  name: 'Executive Report Agent',
  description: 'Synthesizes every specialist agent into one growth summary.',
  category: 'meta',
  version: 4,
  requires: ['query-intelligence', 'opportunity', 'country-intelligence', 'device-intelligence', 'ai-visibility', 'content-gap', 'competitor-intelligence'],
};

// Thin config over the shared orchestrator (orchestrator.js) — this agent no
// longer hand-rolls its own fan-out + synthesis; it just tells the
// orchestrator which agents to run. persistSubAgentRuns stays false so
// running the executive report still doesn't write redundant agent_runs
// rows, same intent as the original direct agent.run() calls.
export async function run(input) {
  const result = await runOrchestration({ ...input, agentIds: meta.requires, persistSubAgentRuns: false });
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
