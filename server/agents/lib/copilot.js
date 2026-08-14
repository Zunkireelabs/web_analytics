import { listAgentMeta } from '../registry.js';
import { runOrchestration, synthesizeFindings, PRIORITY_RANK } from '../orchestrator.js';
import { getLatestAgentRuns, getLatestFindings } from './fresh-runs.js';
import { saveMessage } from '../../store/copilot.js';
import { RECOMMENDATION_AGENT_IDS } from './insights.js';
import { callLLM } from '../../llm.js';
import { buildRecommendations } from './recommendations.js';
import { agenticOrchestrationEnabled, runAgenticLoop } from './agentic-orchestrator.js';
import { systemPromptFor, resolveDisplayName } from './copilot-greeting.js';
import { getUserById } from '../../store/users.js';
import { getSiteById } from '../../store/read.js';
import { PLATFORM_GUIDE } from './platform-guide.js';

// Who is being answered, resolved server-side. Never throws — an unresolvable
// user falls back to the client persona, which is the safe default because it
// is the one that forbids internal vocabulary.
async function resolvePersona(siteId, userId) {
  const [user, site] = await Promise.all([
    userId ? getUserById(userId).catch(() => null) : null,
    getSiteById(siteId).catch(() => null),
  ]);
  const isAdmin = user?.role === 'platform_admin';
  return {
    isAdmin,
    systemPrompt: systemPromptFor({
      isAdmin,
      name: resolveDisplayName(user),
      siteLabel: site?.website_domain || site?.name || 'this site',
    }),
  };
}

// "Reuse cached intelligence whenever possible. Only run agents when
// information is stale or unavailable." — matches the daily ingest cadence,
// so a question never triggers a live run just because it's been a few
// minutes since the last one.
const STALE_MS = 24 * 60 * 60 * 1000;

function last7Days() {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { start, end };
}

function stripJsonFences(raw) {
  return raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
}

// The user never needs to know which agents exist — an LLM maps the
// question onto the SAME dynamic catalog listAgentMeta() already exposes
// (no hardcoded question→agent table to keep in sync as agents are added).
// "summary" mode short-circuits straight to the latest executive briefing
// instead of routing to specific agents, for broad asks like "what's new."
async function classifyIntent(message, history) {
  const agents = await listAgentMeta();
  const catalog = agents
    .filter((a) => a.id !== 'executive-report')
    .map((a) => ({ id: a.id, description: a.description, dataSources: a.dataSources || [] }));
  const validIds = new Set(catalog.map((a) => a.id));

  const system = 'You are an intent router for an AI copilot embedded in an SEO/analytics dashboard, talking to a ' +
    'non-technical site owner or staff admin. Given the user\'s question, recent conversation, and a catalog of ' +
    'specialist agents (id, description, and which real data sources each one has connected), decide how to route ' +
    'it. Never invent an agent id that is not in the catalog. Three modes:\n' +
    '- "route": a question about THIS SITE\'s SEO/traffic/data — pick the relevant agent ids.\n' +
    '- "summary": a broad, non-specific recap of site data ("summarize today", "what\'s new", "how are we doing") ' +
    '— empty agentIds array.\n' +
    '- "platform-help": a question about the DASHBOARD/APP ITSELF, not the site\'s data — navigation, "how do I", ' +
    '"where do I find", what a page/button/feature does, how to approve or ship a fix, etc. — empty agentIds array.\n' +
    'Respond with ONLY JSON: {"mode": "route" | "summary" | "platform-help", "agentIds": ["..."]}.';
  const user = `Catalog: ${JSON.stringify(catalog)}\nRecent conversation: ${JSON.stringify(history)}\nQuestion: ${message}`;

  const raw = await callLLM(system, user, { maxTokens: 200 }).catch(() => null);
  if (!raw) return { mode: 'route', agentIds: RECOMMENDATION_AGENT_IDS }; // safe fallback: ask everyone rather than fail silently
  try {
    const parsed = JSON.parse(stripJsonFences(raw));
    if (parsed.mode === 'platform-help') return { mode: 'platform-help', agentIds: [] };
    const agentIds = Array.isArray(parsed.agentIds) ? parsed.agentIds.filter((id) => validIds.has(id)) : [];
    return { mode: parsed.mode === 'summary' ? 'summary' : 'route', agentIds: agentIds.length ? agentIds : RECOMMENDATION_AGENT_IDS };
  } catch {
    return { mode: 'route', agentIds: RECOMMENDATION_AGENT_IDS };
  }
}

// Answers "how do I use this app" questions from the static PLATFORM_GUIDE
// only — deliberately separate from answerFromCache/runOrchestration, which
// are grounded in real per-site findings. Mixing the two contexts risks the
// model blending "what this button does" with invented site data, so this
// path never sees agent findings at all.
async function answerPlatformHelp(message, history, personaPrompt) {
  const system = `${personaPrompt}\n\nYou also act as the built-in guide for how to use this dashboard/platform ` +
    'itself. Answer ONLY using the reference below — never invent a page, button, or capability that isn\'t listed ' +
    'in it. If the reference doesn\'t cover what they\'re asking, say so plainly and point them to the closest real ' +
    `page instead of guessing.\n\n${PLATFORM_GUIDE}`;
  const user = `Recent conversation: ${JSON.stringify(history)}\nQuestion: ${message}`;
  const raw = await callLLM(system, user, { maxTokens: 500 }).catch(() => null);
  return raw ? raw.trim() : null;
}

async function staleAgentIds(siteId, agentIds) {
  const runs = await getLatestAgentRuns(siteId, agentIds);
  const byId = new Map(runs.map((r) => [r.agent_id, r]));
  const now = Date.now();
  return agentIds.filter((id) => {
    const run = byId.get(id);
    if (!run) return true; // never run at all — stale by definition
    return now - new Date(run.created_at).getTime() > STALE_MS;
  });
}

// "I don't have that yet" is a real, honest answer — never a bare null. Used
// when there's nothing to synthesize from (no findings, or synthesis
// itself failed), so the routed agent(s)' real status still reaches the
// user in plain language instead of an empty reply.
const STATUS_EXPLANATION = {
  'insufficient-data': 'doesn\'t have enough real data connected yet',
  error: 'hit an error on its last run',
};
async function honestGapMessage(siteId, agentIds) {
  const runs = await getLatestAgentRuns(siteId, agentIds);
  const byId = new Map(runs.map((r) => [r.agent_id, r]));
  const agents = await listAgentMeta();
  const nameById = new Map(agents.map((a) => [a.id, a.name]));

  const gaps = agentIds.map((id) => {
    const run = byId.get(id);
    const name = nameById.get(id) || id;
    if (!run) return `${name} hasn't run yet`;
    if (run.status === 'ok') return null;
    return `${name} ${STATUS_EXPLANATION[run.status] || 'has no answer for this yet'}`;
  }).filter(Boolean);

  return gaps.length
    ? `I don't have enough real data to answer that yet — ${gaps.join('; ')}.`
    : 'I don\'t have enough real data to answer that yet.';
}

// Cached-read path — no agent execution, just a DB read + one synthesis
// call. Findings/summaries are already rich (evidence, whyItMatters,
// priority, recommendedAction per finding), so this stays fast without
// needing each agent's full raw `facts` blob the way a fresh run does.
async function answerFromCache(siteId, agentIds, question, personaPrompt) {
  const runs = await getLatestFindings(siteId, agentIds);
  const findings = runs
    .flatMap((r) => r.findings.map((f) => ({ ...f, agentId: r.agentId })))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const perAgent = Object.fromEntries(runs.map((r) => [r.agentId, { status: 'ok', narrative: r.summary, findingsCount: r.findings.length }]));
  // narrative may still come back null here (no findings, or the LLM call
  // itself failed) — answerQuestion's caller applies the honest-gap fallback
  // uniformly for both this path and the fresh-run path, so it isn't
  // duplicated here.
  const narrative = await synthesizeFindings(findings, perAgent, question, personaPrompt);
  return { findings, narrative, ranAgentIds: agentIds, fromCache: true };
}

async function suggestFollowUps(question, answer) {
  if (!answer) return [];
  const system = 'Given a question and its answer from an SEO/analytics AI copilot, suggest exactly 2 short, ' +
    'natural follow-up questions the user might genuinely ask next — specific to what was just discussed, never ' +
    'generic ("tell me more"). Respond with ONLY a JSON array of exactly 2 short question strings.';
  const raw = await callLLM(system, `Question: ${question}\nAnswer: ${answer}`, { maxTokens: 150 }).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(stripJsonFences(raw));
    return Array.isArray(parsed) ? parsed.slice(0, 2).filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

// The single entry point routes/copilot.js calls. Never exposes agent ids
// in the answer text itself — `ranAgentIds` travels back only as metadata
// (agent_ids_used on the persisted message) for internal transparency, not
// user-facing copy.
export async function answerQuestion({ siteId, conversationId, message, history, userId }) {
  // Audience is resolved from the SESSION's user, never from anything the
  // caller passed in the request body — a client cannot ask to be answered as
  // an admin. Failing to resolve it degrades to the client persona (the more
  // conservative of the two: it exposes no internal vocabulary), rather than
  // to the admin one.
  const [routing, persona] = await Promise.all([
    classifyIntent(message, history),
    resolvePersona(siteId, userId),
  ]);
  const personaPrompt = persona.systemPrompt;

  let result;
  if (routing.mode === 'platform-help') {
    result = {
      findings: [],
      narrative: await answerPlatformHelp(message, history, personaPrompt),
      ranAgentIds: [],
    };
  } else if (routing.mode === 'summary') {
    const [execRun] = await getLatestAgentRuns(siteId, ['executive-report']);
    result = {
      findings: execRun?.facts?.findings || [],
      narrative: execRun?.narrative || 'No analysis has run yet — check back after the first daily analysis completes.',
      ranAgentIds: ['executive-report'],
    };
  } else if (agenticOrchestrationEnabled()) {
    // classifyIntent's own agentIds guess is discarded here — the agentic
    // loop does its own fresh, iterative, tool-based selection instead of
    // trusting a one-shot classification, which is exactly the behavior
    // being replaced. Falls back to the legacy classify+orchestrate path on
    // any failure (bad key, network, model misbehavior) rather than ever
    // surfacing a hard error to the user.
    const { start, end } = last7Days();
    try {
      result = await runAgenticLoop({ siteId, start, end, question: message, history, persistSubAgentRuns: true, personaPrompt });
    } catch (err) {
      console.warn('[copilot] agentic loop failed, falling back to classify+orchestrate:', err.message);
      const stale = await staleAgentIds(siteId, routing.agentIds);
      result = stale.length
        ? await runOrchestration({ siteId, start, end, agentIds: routing.agentIds, persistSubAgentRuns: true, question: message, personaPrompt })
        : await answerFromCache(siteId, routing.agentIds, message, personaPrompt);
    }
  } else {
    const stale = await staleAgentIds(siteId, routing.agentIds);
    if (stale.length) {
      const { start, end } = last7Days();
      result = await runOrchestration({ siteId, start, end, agentIds: routing.agentIds, persistSubAgentRuns: true, question: message, personaPrompt });
    } else {
      result = await answerFromCache(siteId, routing.agentIds, message, personaPrompt);
    }
  }

  // A bare null answer is never acceptable — if synthesis genuinely had
  // nothing to work with, say so plainly instead of returning nothing.
  const answer = result.narrative || await honestGapMessage(siteId, result.ranAgentIds);
  const followUps = await suggestFollowUps(message, answer);
  const citedFindingIds = result.findings.slice(0, 5).map((f) => f.id);

  await saveMessage(conversationId, 'assistant', answer, { citedFindingIds, followUps, agentIdsUsed: result.ranAgentIds });

  // Same real-actionability check Action Center's own Findings List uses
  // (buildRecommendations already excludes already-implemented findings and
  // ungrounded meta-title/faq params — see recommendations.js) — a cited
  // finding only gets a "Generate Draft" affordance in chat when it's a
  // finding that Action Center itself would let you generate a draft for,
  // never a guess at what might be actionable.
  const grounded = await buildRecommendations(siteId);
  const groundedById = new Map(grounded.items.map((item) => [item.id, item]));

  return {
    answer,
    citedFindings: result.findings.slice(0, 5).map((f) => {
      const item = groundedById.get(f.id);
      return {
        id: f.id, whyItMatters: f.whyItMatters, evidence: f.evidence,
        actionable: item ? { generatorId: item.generatorId, params: item.params, tag: item.tag, source: item.source } : null,
      };
    }),
    followUps,
  };
}
