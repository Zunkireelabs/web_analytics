import { listAgentMeta } from './registry.js';
import { runAgent } from './runner.js';
import { callLLM } from '../llm.js';

// The one shared place that knows how to run N specialist agents and combine
// their structured findings into one answer. Executive Report, Action
// Center's refresh, and any future AI Chat / notifier are all thin,
// differently-configured callers of this — none of them re-implements its
// own fan-out + synthesis loop. See agents/types.js OrchestratorInput/Output.

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

const SYNTHESIS_SYSTEM = 'You are a growth strategist synthesizing structured findings from multiple specialist ' +
  'analytics agents into one combined answer for a non-technical site owner. Each finding carries real evidence, ' +
  'a priority (high/medium/low), why it matters, and a recommended action where one exists. Write 4-6 sentences ' +
  'covering the highest-priority findings first. If an agent errored or returned insufficient data, name it ' +
  'plainly as a gap rather than omitting it. Use ONLY the evidence given, never invent numbers. A lower average ' +
  'Search position is BETTER. Plain text, no markdown, no bullets.';

export async function runOrchestration({ siteId, start, end, agentIds, question, persistSubAgentRuns = false } = {}) {
  // `question` is reserved for a future AI chat (would pick agentIds from
  // listAgentMeta() descriptions instead of the caller hardcoding them) —
  // unused today, not implemented this phase.
  const ids = agentIds?.length
    ? agentIds
    : (await listAgentMeta()).map((m) => m.id).filter((id) => id !== 'executive-report');

  const ran = await Promise.all(ids.map(async (id) => {
    try {
      const out = await runAgent(id, { siteId, start, end }, { persist: persistSubAgentRuns });
      return [id, out];
    } catch (err) {
      console.error(`[orchestrator] agent "${id}" failed:`, err.message);
      return [id, { status: 'error', message: String(err?.message || err) }];
    }
  }));

  // perAgent carries each sub-agent's full output (status/facts/narrative/
  // message), not just a summary — report/executive-doc.js's weekly Google
  // Doc synthesis needs the full real facts (gainers, growing markets,
  // estimatedTrafficGain, etc.) of every sub-agent, not a lightweight digest.
  const perAgent = {};
  const findings = [];
  for (const [id, out] of ran) {
    perAgent[id] = {
      status: out.status, facts: out.facts ?? null, narrative: out.narrative ?? null,
      message: out.message ?? null, findingsCount: out.facts?.findings?.length || 0,
    };
    if (out.status === 'ok') {
      for (const f of out.facts?.findings || []) findings.push({ ...f, agentId: id });
    }
  }
  findings.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);

  const narrative = findings.length
    ? await callLLM(SYNTHESIS_SYSTEM, `Findings: ${JSON.stringify(findings)}\nAgent statuses: ${JSON.stringify(perAgent)}`, { maxTokens: 450 })
      .catch((err) => { console.warn('[orchestrator] synthesis failed:', err.message); return null; })
    : null;

  return { ranAgentIds: ids, generatedAt: new Date().toISOString(), findings, perAgent, narrative };
}
