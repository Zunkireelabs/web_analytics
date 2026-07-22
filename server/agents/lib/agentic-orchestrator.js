import OpenAI from 'openai';
import { listAgentMeta } from '../registry.js';
import { runAgent } from '../runner.js';
import { createPageCache } from './fetch-cache.js';
import { summarizeAgentRuns } from '../orchestrator.js';
import { withRetry, isRetryable } from '../../llm.js';
import { normalizeCompetitorDomain } from './competitor-analysis.js';
import { saveAgenticOrchestrationRun } from '../../store/agentic-orchestration-runs.js';

// A genuine multi-round LLM tool-calling loop, distinct from orchestrator.js's
// runOrchestration: that one always fans a FIXED agentIds list out in one
// Promise.all batch. Here the LLM itself decides, one tool call at a time,
// which specialist agents are worth invoking — and after seeing their real
// findings, whether it needs to call another agent before answering/
// deciding. Kept in its own file (not added to orchestrator.js) because the
// execution model is structurally different: multi-round, stateful,
// OpenAI-tool-specific, not just another configuration of the existing
// single-shot fan-out.
//
// Deliberately OpenAI-only (unlike llm.js's callLLM, which auto-switches
// provider) — this is new infrastructure with no existing dual-provider
// tool-calling support to preserve, and OpenAI's tools API is what this was
// built and verified against.

// Same double-gate pattern as ai-recommendation's model-providers/openai.js
// configured(): never let OPENAI_API_KEY's mere presence (already set in
// most deployments for the unrelated daily-narrative feature) silently turn
// on this new, more expensive multi-round behavior. AGENTIC_ORCHESTRATION_ENABLED
// is this feature's own dedicated opt-in.
export function agenticOrchestrationEnabled() {
  const key = process.env.OPENAI_API_KEY;
  const hasRealKey = !!key && !key.startsWith('sk-xxxx');
  return hasRealKey && process.env.AGENTIC_ORCHESTRATION_ENABLED === 'true';
}

const MODEL = process.env.AGENTIC_ORCHESTRATION_MODEL || 'gpt-4o-mini';

// LLM decision turns, not agent invocations — bounds how many times the
// model gets to look at results and decide to call more tools before it's
// forced to answer. Env-overridable (same convention MODEL already uses)
// so this can be tuned without a code change once real usage/cost data comes in.
const AGENTIC_MAX_ROUNDS = Number(process.env.AGENTIC_MAX_ROUNDS) || 4;
// Hard ceiling on real agent invocations per session — equal to the total
// number of selectable agents, so this can never cost more than today's
// fixed "run everything" worst case.
const AGENTIC_MAX_TOOL_CALLS = Number(process.env.AGENTIC_MAX_TOOL_CALLS) || 10;

const QUESTION_SYSTEM = 'You are a senior growth analyst answering a specific question from a non-technical site ' +
  'owner. You have one tool per specialist growth/SEO agent — call only the agents whose real data you actually ' +
  'need to answer the question; do not call every agent by default. Some agents (content-gap, ' +
  'competitor-intelligence) accept optional parameters to scope a call to one specific page or competitor instead ' +
  'of their normal batch — use them when the question names a specific page/competitor. You may call more than ' +
  'one agent, and after seeing their real findings you may call additional agents if you decide you need more ' +
  'evidence before answering — never guess when a tool could tell you. You also have several inspect_* tools ' +
  '(inspect_page for everything about one URL, or inspect_schema/inspect_metadata/inspect_links/inspect_images/' +
  'inspect_headings for one narrow aspect of it) for grounding a question about one specific URL without running ' +
  'a full agent — prefer the narrowest inspect_* tool that answers the question before escalating to a full ' +
  'agent. You also have an ask_user tool for when the question is genuinely ambiguous (e.g. it references "this ' +
  'page" or "my rankings" without saying which) — use ask_user only when you truly cannot proceed, not as a way ' +
  'to avoid calling other tools. A tool result with status "error" is not fatal — do not give up or ask the user ' +
  'unnecessarily; keep going, call a different agent if useful, or answer honestly from whatever evidence did ' +
  'succeed. Once you have enough evidence, respond with your final answer as plain text (not a tool call): answer ' +
  'directly and concisely, address exactly what was asked, do not write a generic briefing. If the findings ' +
  'don\'t contain enough to answer honestly, say so plainly rather than guessing or padding with unrelated ' +
  'findings. Use ONLY the evidence returned by the tools, never invent numbers. A lower average Search position ' +
  'is BETTER. Plain text, no markdown, no bullets.';

const SELECTION_SYSTEM = 'You are deciding which of a site\'s specialist growth/SEO checks are worth re-running ' +
  'right now, given each one\'s last-run staleness listed below. Call the tool for any agent that is stale or has ' +
  'never run; skip agents that already ran recently unless the agent\'s own description gives a real reason to ' +
  'refresh it anyway. A tool result with status "error" is not fatal — continue evaluating and calling the ' +
  'remaining agents worth refreshing. You do not need to write a detailed final answer — once you have called ' +
  'every agent worth refreshing, reply with one short plain-text sentence summarizing what you refreshed (or ' +
  'state that nothing needed refreshing). Never call an agent purely because it exists.';

// Only offered in question mode: ask_user needs a human to answer, and
// inspect_page is for grounding a specific-URL question — neither makes
// sense for the non-interactive Action Center staleness-selection call site.
const ASK_USER_TOOL = {
  type: 'function',
  function: {
    name: 'ask_user',
    description: 'Ask the site owner a clarifying question when their question is genuinely ambiguous and no ' +
      'tool call could resolve the ambiguity (e.g. they said "this page" without saying which one).',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
};

// One real fetch per URL per session (pageCache coalesces by URL), projected
// down to whichever field subset each narrower inspect_* tool asks for —
// calling several of these on the same URL in one session still costs one
// fetch total. null = full analysis object, unchanged inspect_page behavior.
const INSPECT_FIELD_SETS = {
  inspect_page: null,
  inspect_schema: ['hasSchema', 'schemaTypes', 'hasFaqSchema'],
  inspect_metadata: ['title', 'metaDescription', 'hasMetaDescription', 'hasOpenGraph', 'hasCanonical'],
  inspect_links: ['internalLinkCount', 'internalLinks'],
  inspect_images: ['imagesTotal', 'imagesWithoutAlt'],
  inspect_headings: ['h1Count', 'h2Count', 'questionHeadingCount', 'hasComparisonContent'],
};

const INSPECT_DESCRIPTIONS = {
  inspect_page: 'Fetch and analyze one specific page URL (title, meta description, schema, FAQ/comparison ' +
    'content, internal links, images missing alt text, etc.) — cheaper than running a full agent when the ' +
    'question is about a single known page.',
  inspect_schema: 'Check one page\'s structured data only (schema.org types present, FAQPage schema) — cheaper ' +
    'than inspect_page when you only need to know about schema markup.',
  inspect_metadata: 'Check one page\'s title, meta description, and Open Graph/canonical tags only.',
  inspect_links: 'Check one page\'s internal link count and targets only.',
  inspect_images: 'Check one page\'s image count and how many are missing alt text only.',
  inspect_headings: 'Check one page\'s heading structure (H1/H2 counts, question-style headings, comparison ' +
    'content) only.',
};

function projectAnalysis(analysis, fields) {
  return fields ? Object.fromEntries(fields.map((f) => [f, analysis[f]])) : analysis;
}

const INSPECT_TOOLS = Object.keys(INSPECT_FIELD_SETS).map((name) => ({
  type: 'function',
  function: {
    name,
    description: INSPECT_DESCRIPTIONS[name],
    parameters: {
      type: 'object',
      properties: { page: { type: 'string', description: 'Full URL of the page to inspect' } },
      required: ['page'],
      additionalProperties: false,
    },
  },
}));

// Pilot for AgentInput.params (documented in types.js as "agent-specific
// knobs, validated by the agent itself — never the router") — only these two
// agent ids get a non-empty tool schema and a params parser; every other
// agent id is completely unaffected (empty schema, input.params stays
// undefined, exactly today's behavior). Each parser mirrors the same manual
// try/catch-JSON.parse convention already used for ask_user/inspect_page,
// and returns undefined (not a partial object) on anything invalid so the
// dispatch below can treat "no usable params" as "call it unparameterized."
const AGENT_TOOL_PARAMS = {
  'content-gap': {
    type: 'object',
    properties: { page: { type: 'string', description: 'Full URL of one specific page to check instead of the normal rotation batch' } },
    additionalProperties: false,
  },
  'competitor-intelligence': {
    type: 'object',
    properties: { competitor: { type: 'string', description: 'A specific competitor domain to force into this run\'s analysis, even if discovery wouldn\'t have surfaced it' } },
    additionalProperties: false,
  },
};

const PARAM_PARSERS = {
  'content-gap': (raw) => {
    let page;
    try { page = JSON.parse(raw || '{}').page; } catch { page = null; }
    return page ? { page } : undefined;
  },
  'competitor-intelligence': (raw) => {
    let competitor;
    try { competitor = JSON.parse(raw || '{}').competitor; } catch { competitor = null; }
    const normalized = normalizeCompetitorDomain(competitor);
    return normalized ? { competitor: normalized } : undefined;
  },
};

// An agent whose dataSources are ALL not-connected (per types.js's own
// AgentMeta contract) always returns status:'insufficient-data' — calling it
// only wastes a round, so it's excluded from the tool list entirely. Note:
// ai-visibility.js lists two not-connected dataSources but its run() never
// actually checks them and always returns real findings from local page
// analysis — a pre-existing spec/implementation mismatch in that file, out
// of scope to fix here. This filter is still correct for the agents (e.g.
// authority, ai-recommendation) that really do gate on their data source;
// ai-visibility being excluded from just this tool list is an accepted side
// effect — it stays fully reachable via the manual run route, cron, and the
// legacy orchestrator fallback.
function hasNoUsableDataSource(agent) {
  return !!agent.dataSources?.length && agent.dataSources.every((d) => d.status !== 'connected');
}

async function buildAgentTools(mode) {
  const agents = (await listAgentMeta())
    .filter((a) => a.id !== 'executive-report')
    .filter((a) => !hasNoUsableDataSource(a));
  const agentTools = agents.map((a) => ({
    type: 'function',
    function: {
      name: a.id,
      description: a.description,
      parameters: AGENT_TOOL_PARAMS[a.id] || { type: 'object', properties: {}, additionalProperties: false },
    },
  }));
  return mode === 'question' ? [...agentTools, ...INSPECT_TOOLS, ASK_USER_TOOL] : agentTools;
}

// Only what the model needs to reason about a finding — never the raw
// facts blob, so a session that calls several agents doesn't blow past
// context/token limits.
function compactToolResult(out) {
  return {
    status: out.status,
    narrative: out.narrative,
    message: out.message ?? null,
    findings: (out.facts?.findings || []).slice(0, 10).map((f) => ({
      id: f.id, whyItMatters: f.whyItMatters, priority: f.priority, evidence: f.evidence,
    })),
  };
}

function finalize(text, invoked) {
  const { findings, perAgent } = summarizeAgentRuns([...invoked.entries()]);
  return {
    ranAgentIds: [...invoked.keys()],
    generatedAt: new Date().toISOString(),
    findings,
    perAgent,
    narrative: text?.trim() || null,
  };
}

function addUsage(totals, res) {
  totals.promptTokens += res.usage?.prompt_tokens || 0;
  totals.completionTokens += res.usage?.completion_tokens || 0;
}

function logDone(roundsUsed, totalCalls, usage) {
  console.log(`[agentic-orchestrator] done after ${roundsUsed} round(s), ${totalCalls} agent call(s), ` +
    `${usage.promptTokens} prompt + ${usage.completionTokens} completion tokens`);
}

// One bounded retry for a transient runAgent() failure (network blip inside
// an agent's own fetch/DB calls) — reuses llm.js's isRetryable() check,
// which is generic (status/code based, not OpenAI-SDK-specific) so it
// applies fine to arbitrary agent-thrown errors. Not a full backoff loop:
// the caller's own dispatch loop already bounds total cost via
// AGENTIC_MAX_TOOL_CALLS, so one immediate retry is enough here. A retried
// call does emit two activity-bus/agent_runs entries instead of one — an
// accepted, more-honest-than-hiding-it side effect, not a bug.
async function runAgentWithRetry(id, input, opts) {
  try {
    return await runAgent(id, input, opts);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    console.warn(`[agentic-orchestrator] "${id}" failed transiently, retrying once: ${err.message}`);
    return runAgent(id, input, opts);
  }
}

// AGENTIC_MAX_ROUNDS/AGENTIC_MAX_TOOL_CALLS are the ceiling; these two pure,
// synchronous heuristics (no extra LLM/network call — kept cheap) estimate a
// smaller per-session budget for simple cases. Deliberately biased toward
// the larger budget when uncertain: guessing "simple" for a complex question
// just triggers the existing graceful forced-close-out path a bit early (no
// new failure mode), while guessing "complex" for a simple one costs no more
// than today's fixed behavior.
const MIN_ROUNDS = 2;
const MIN_TOOL_CALLS = 3;
const BREADTH_KEYWORDS = /\b(compare|comparison|all|every|both|vs\.?|versus|overall|everything|across)\b/i;

export function estimateQuestionBudget(question) {
  if (!question) return { rounds: AGENTIC_MAX_ROUNDS, toolCalls: AGENTIC_MAX_TOOL_CALLS };
  const qMarks = (question.match(/\?/g) || []).length;
  const isBroad = BREADTH_KEYWORDS.test(question) || qMarks > 1 || question.length > 150;
  return isBroad
    ? { rounds: AGENTIC_MAX_ROUNDS, toolCalls: AGENTIC_MAX_TOOL_CALLS }
    : { rounds: Math.min(AGENTIC_MAX_ROUNDS, MIN_ROUNDS), toolCalls: Math.min(AGENTIC_MAX_TOOL_CALLS, MIN_TOOL_CALLS) };
}

// Parses buildStalenessContext()'s "- id: description (age)" lines (age is
// either 'never run' or 'last ran Nh ago') to count how many agents are
// actually worth refreshing, and scales the budget to that real count
// instead of always assuming the ceiling.
const STALE_HOURS_THRESHOLD = 24;

export function estimateSelectionBudget(staleness) {
  if (!staleness) return { rounds: AGENTIC_MAX_ROUNDS, toolCalls: AGENTIC_MAX_TOOL_CALLS };
  const staleCount = staleness.split('\n').filter((line) => {
    const m = line.match(/last ran (\d+)h ago/);
    return line.includes('never run') || (m && Number(m[1]) >= STALE_HOURS_THRESHOLD);
  }).length;
  const toolCalls = Math.max(MIN_TOOL_CALLS, Math.min(AGENTIC_MAX_TOOL_CALLS, staleCount || MIN_TOOL_CALLS));
  const rounds = Math.max(MIN_ROUNDS, Math.min(AGENTIC_MAX_ROUNDS, Math.ceil(toolCalls / 3) + 1));
  return { rounds, toolCalls };
}

// One extra non-tool completion call, question mode only (selection mode's
// per-agent staleness decision has no cross-agent sequencing to plan, so
// there's no payoff there). The plan text is NEVER returned to the caller —
// only logged and folded into `messages` as a second system message (not an
// 'assistant' message — a second system message is the unambiguous way to
// add steering content not attributed to either party) so the model's
// subsequent tool choices are conditioned on it. Doesn't count against
// budget.rounds — it runs entirely outside the round loop.
const PLAN_SYSTEM_ADDENDUM = 'Before acting, silently think through which specialist agents (if any) you will ' +
  'likely need and in what order, and whether an inspect_* tool would ground the question first. Respond with ' +
  'only a few short sentences of plain-text internal reasoning — never shown to the user, so do not address them ' +
  'and do not give a final answer here.';

async function planQuestion(client, messages, usage) {
  const res = await withRetry(() => client.chat.completions.create({
    model: MODEL, messages: [...messages, { role: 'system', content: PLAN_SYSTEM_ADDENDUM }], max_tokens: 200,
  }));
  addUsage(usage, res);
  const plan = res.choices[0].message.content?.trim();
  if (plan) console.log(`[agentic-orchestrator] internal plan: ${plan}`);
  return plan;
}

// Exactly one of `question` (Copilot mode) or `staleness` (Action Center
// mode) is set — same "mode picked by which optional field is present"
// convention orchestrator.js's synthesizeFindings already uses.
export async function runAgenticLoop({
  siteId, start, end, question, history, staleness, persistSubAgentRuns = false,
} = {}) {
  const startedAt = Date.now();
  const mode = staleness != null ? 'selection' : 'question';
  const tools = await buildAgentTools(mode);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const pageCache = createPageCache();
  const usage = { promptTokens: 0, completionTokens: 0 };
  const budget = mode === 'selection' ? estimateSelectionBudget(staleness) : estimateQuestionBudget(question);

  const systemPrompt = mode === 'selection' ? SELECTION_SYSTEM : QUESTION_SYSTEM;
  const userPrompt = mode === 'selection'
    ? `Agents and their staleness:\n${staleness}`
    : `Recent conversation: ${JSON.stringify(history || [])}\nQuestion: ${question}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  if (mode === 'question') {
    const plan = await planQuestion(client, messages, usage);
    if (plan) messages.push({ role: 'system', content: `[internal plan, not shown to user] ${plan}` });
  }

  const invoked = new Map(); // agentId -> AgentOutput, dedupes repeat tool calls across rounds within one session
  let totalCalls = 0;
  let roundsUsed = 0;

  try {
    for (let round = 0; round < budget.rounds; round++) {
      roundsUsed = round + 1;
      const res = await withRetry(() => client.chat.completions.create({
        model: MODEL, messages, tools, tool_choice: 'auto', max_tokens: 500,
      }));
      addUsage(usage, res);
      const msg = res.choices[0].message;
      messages.push(msg);

      if (!msg.tool_calls?.length) {
        logDone(roundsUsed, totalCalls, usage);
        return finalize(msg.content, invoked);
      }

      console.log(`[agentic-orchestrator] round ${roundsUsed}: model requested ${msg.tool_calls.map((tc) => tc.function.name).join(', ')}`);

      // ask_user short-circuits the whole loop immediately — the model's
      // question IS the answer, and copilot.js's persisted conversation
      // history is what lets the user's reply resume the exchange next turn,
      // so no separate pause/resume state is needed here.
      const askUserCall = msg.tool_calls.find((tc) => tc.function.name === 'ask_user');
      if (askUserCall) {
        let clarifyingQuestion;
        try { clarifyingQuestion = JSON.parse(askUserCall.function.arguments || '{}').question; } catch { clarifyingQuestion = null; }
        logDone(roundsUsed, totalCalls, usage);
        return finalize(clarifyingQuestion || 'Could you clarify your question?', invoked);
      }

      // Budget/dedup decisions happen synchronously, in tool_call order,
      // before any agent actually runs — so which calls count against
      // budget.toolCalls never depends on network timing. The real
      // runAgent() calls themselves then run concurrently (mirrors
      // orchestrator.js's Promise.all fan-out) instead of one-at-a-time.
      //
      // Dedup key: a plain call (no resolved params) dedupes by agent id
      // alone, across the whole session — exactly today's behavior. A
      // parameterized call (content-gap/competitor-intelligence with real
      // params) only coalesces a literal repeat WITHIN this round —
      // plain-id dedup isn't a safe cache key once params vary (the same
      // agent may legitimately need to run again later for a different
      // page/competitor).
      const pendingThisRound = new Map(); // compositeKey -> Promise<AgentOutput>
      for (const tc of msg.tool_calls) {
        const id = tc.function.name;
        if (id in INSPECT_FIELD_SETS) continue;
        const params = PARAM_PARSERS[id]?.(tc.function.arguments);
        const key = params ? `${id}::${JSON.stringify(params)}` : id;
        if (params ? pendingThisRound.has(key) : (invoked.has(key) || pendingThisRound.has(key))) continue;
        if (totalCalls >= budget.toolCalls) continue;
        totalCalls++;
        const input = { siteId, start, end, pageCache, ...(params ? { params } : {}) };
        pendingThisRound.set(key, runAgentWithRetry(id, input, { persist: persistSubAgentRuns })
          .catch((err) => ({ status: 'error', message: String(err?.message || err) })));
      }

      const results = await Promise.all(msg.tool_calls.map(async (tc) => {
        const id = tc.function.name;

        if (id in INSPECT_FIELD_SETS) {
          let page;
          try { page = JSON.parse(tc.function.arguments || '{}').page; } catch { page = null; }
          if (!page) return { tc, content: { error: 'no page url given' } };
          const fetched = await pageCache(page);
          return { tc, content: fetched.ok ? projectAnalysis(fetched.analysis, INSPECT_FIELD_SETS[id]) : { error: fetched.error || 'fetch failed' } };
        }
        const params = PARAM_PARSERS[id]?.(tc.function.arguments);
        const key = params ? `${id}::${JSON.stringify(params)}` : id;
        if (!params && invoked.has(key)) return { tc, content: compactToolResult(invoked.get(key)) };
        if (pendingThisRound.has(key)) {
          const out = await pendingThisRound.get(key);
          invoked.set(id, out); // always id-keyed — ranAgentIds/perAgent/copilot's agentIdsUsed expect real agent ids; last real call per id wins
          return { tc, content: compactToolResult(out) };
        }
        return { tc, content: { error: 'tool call budget exceeded, skipped' } };
      }));

      for (const { tc, content } of results) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(content) });
      }

      if (totalCalls >= budget.toolCalls) break;
    }

    // Round cap reached (or tool-call budget exhausted) but the model still
    // wanted to call tools — force one close-out turn with tools omitted so
    // it must answer in text instead of requesting another round.
    messages.push({ role: 'user', content: 'Give your final answer now, based on everything above, without calling any more tools.' });
    const finalRes = await withRetry(() => client.chat.completions.create({ model: MODEL, messages, max_tokens: 500 }));
    addUsage(usage, finalRes);
    logDone(roundsUsed, totalCalls, usage);
    return finalize(finalRes.choices[0].message.content, invoked);
  } finally {
    // Best-effort, operational-metrics-only telemetry — never blocks or
    // alters the return above (this `finally` re-throws any error from the
    // try block untouched), and still captures partial stats for a session
    // that ultimately throws and falls back to the legacy orchestrator at
    // the call site. No question text, no narrative, no findings content —
    // same "real events only, never synthesized" discipline as migration
    // 021 (notifications).
    await saveAgenticOrchestrationRun({
      siteId, mode, roundsUsed, toolCallsUsed: totalCalls, toolIdsUsed: [...invoked.keys()],
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, tookMs: Date.now() - startedAt,
    }).catch((err) => console.error('[agentic-orchestrator] failed to save orchestration stats:', err.message));
  }
}
