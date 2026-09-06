import { listAgentMeta } from './registry.js';
import { runAgent } from './runner.js';
import { callLLM } from '../llm.js';
import { createPageCache } from './lib/fetch-cache.js';
import { safeMessage } from '../lib/errors.js';

// The one shared place that knows how to run N specialist agents and combine
// their structured findings into one answer. Executive Report, Action
// Center's refresh, and any future AI Chat / notifier are all thin,
// differently-configured callers of this — none of them re-implements its
// own fan-out + synthesis loop. See agents/types.js OrchestratorInput/Output.

export const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

const BRIEFING_SYSTEM = 'You are a senior growth consultant writing a short daily briefing for a business owner ' +
  'with no SEO or technical background. Given structured findings from multiple specialist agents (each with real ' +
  'evidence, a priority of high/medium/low, why it matters, and a recommended action where one exists), respond ' +
  'with EXACTLY 5 short lines, one plain-English sentence each, in this exact order, each on its own line, no ' +
  'markdown, no bullet characters, no headers:\n' +
  'Line 1: the single most significant real change, stated as a plain fact (e.g. "Traffic declined 8% this week.").\n' +
  'Line 2: "Main reason: " followed by the real cause of that change in plain language.\n' +
  'Line 3: "Highest priority: " followed by the single most urgent real issue found.\n' +
  'Line 4: "Recommended action: " followed by one concrete next step in plain language.\n' +
  'Line 5: "Potential impact: " followed by the plain-language benefit of taking that action.\n' +
  'If an agent errored or returned insufficient data, say so plainly in whichever line it is most relevant to ' +
  'rather than omitting it. Use ONLY the evidence given, never invent numbers. A lower average Search position is ' +
  'BETTER. Never use jargon (e.g. no "CTR", "SERP", "crawl budget", "impressions") — describe things the way a ' +
  'marketing consultant would explain them to a client.';

const QUESTION_SYSTEM = 'You are a senior growth analyst answering a specific question from a non-technical site ' +
  'owner, using structured findings from specialist agents (each with real evidence, a priority, why it matters, ' +
  'and a recommended action where one exists). Answer the question directly and concisely — do not write a ' +
  'generic briefing, address exactly what was asked. If the findings don\'t contain enough to answer honestly, say ' +
  'so plainly rather than guessing or padding with unrelated findings. Use ONLY the evidence given, never invent ' +
  'numbers. A lower average Search position is BETTER. Plain text, no markdown, no bullets.';

// Shared by runOrchestration (fresh runs, generic briefing) and the AI
// Copilot's cached-read path (agents/lib/copilot.js) — one synthesis
// implementation regardless of whether the findings came from a live run or
// a DB read, and regardless of whether it's a briefing or an answer to a
// specific question.
// `systemOverride` lets the Copilot substitute an audience-shaped system
// prompt (agents/lib/copilot-greeting.js's systemPromptFor) now that one chat
// surface serves both platform admins and site owners — a client must not be
// answered in internal vocabulary (agent ids, risk tiers, draft states).
// Every other caller passes nothing and keeps the existing behaviour exactly.
export async function synthesizeFindings(findings, perAgent, question, systemOverride = null) {
  if (!findings.length) return null;
  const system = systemOverride || (question ? QUESTION_SYSTEM : BRIEFING_SYSTEM);
  const user = (question ? `Question: ${question}\n` : '') +
    `Findings: ${JSON.stringify(findings)}\nAgent statuses: ${JSON.stringify(perAgent)}`;
  return callLLM(system, user, { maxTokens: 450 })
    .catch((err) => { console.warn('[orchestrator] synthesis failed:', err.message); return null; });
}

// Turns a batch of [id, AgentOutput] pairs into the {findings, perAgent}
// shape every OrchestratorOutput carries — shared by runOrchestration below
// and the agentic tool-calling loop (agents/lib/agentic-orchestrator.js),
// which invokes agents one at a time via LLM tool calls rather than a single
// Promise.all fan-out, but needs the exact same result shape so downstream
// consumers (citedFindings grounding, buildRecommendations, the weekly
// executive Google Doc) never need to know which path produced it.
export function summarizeAgentRuns(ran) {
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
  return { findings, perAgent };
}

// Hard ceiling on any ONE agent inside the Promise.all fan-out below. Without
// this, a single hung agent blocks the entire battery forever: Promise.all
// only resolves once every promise does, so runDailyAgentAnalysisForSite
// never reaches saveAgentRun (the executive-report row the hourly catch-up
// guard checks for), buildRecommendations, or shipping — a fault in ANY ONE
// of 16 daily agents, current or future, silently costs the whole day.
// Confirmed live, 2026-09-03: two separate detection attempts both
// completed exactly the same 8 lightweight/site-wide agents and never
// persisted a run for any of the 8 slower, real-per-page agents
// (content-integrity, duplicate-content, ai-visibility, etc.) — the whole
// battery was still waiting on at least one of them when both attempts
// ended. This is a ceiling on the SLOWEST agent, not a total run-time
// budget — every agent runs concurrently, so the whole battery's wall time
// is bounded by this constant regardless of how many agents there are.
// 5 minutes is generous for legitimate per-page work (page-level fetches
// already carry their own much shorter timeout, e.g. page-content.js's
// FETCH_TIMEOUT_MS=5000) while still guaranteeing the battery — and
// therefore the whole daily pipeline behind it — completes in bounded time.
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

// `timeoutMs` and `runAgentFn` are overridable only so a test can prove the
// timeout actually fires without waiting out the real 5 minutes — every real
// caller gets AGENT_TIMEOUT_MS and the real runAgent.
function runAgentWithTimeout(id, input, opts, { timeoutMs = AGENT_TIMEOUT_MS, runAgentFn = runAgent } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[orchestrator] agent "${id}" exceeded ${timeoutMs}ms — treating as failed for this run, not waiting further.`);
      resolve([id, { status: 'error', message: 'This signal took too long to compute and was skipped for this run.' }]);
    }, timeoutMs);
    runAgentFn(id, input, opts).then(
      (out) => {
        if (settled) return; // already timed out — runAgent's own persist call still lands normally when this finally resolves
        settled = true;
        clearTimeout(timer);
        resolve([id, out]);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const { message } = safeMessage(`orchestrator.runOrchestration:${id}`, err, 'this signal is temporarily unavailable');
        resolve([id, { status: 'error', message }]);
      }
    );
  });
}

export async function runOrchestration({
  siteId, start, end, agentIds, question, persistSubAgentRuns = false, personaPrompt = null,
  // Test-only overrides — see runAgentWithTimeout's own comment.
  agentTimeoutMs = AGENT_TIMEOUT_MS, runAgentFn = runAgent,
} = {}) {
  const ids = agentIds?.length
    ? agentIds
    : (await listAgentMeta()).map((m) => m.id).filter((id) => id !== 'executive-report');

  // One fetch cache shared by every agent in this run — see lib/fetch-cache.js
  // for why this needs no special handling to stay out of persisted history.
  const pageCache = createPageCache();

  const ran = await Promise.all(ids.map((id) =>
    runAgentWithTimeout(id, { siteId, start, end, pageCache }, { persist: persistSubAgentRuns }, { timeoutMs: agentTimeoutMs, runAgentFn })
  ));

  const { findings, perAgent } = summarizeAgentRuns(ran);
  const narrative = await synthesizeFindings(findings, perAgent, question, personaPrompt);

  return { ranAgentIds: ids, generatedAt: new Date().toISOString(), findings, perAgent, narrative };
}
