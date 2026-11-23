import { staticAnswer } from './questions.js';
import { handleMessage } from './assistant.js';
import { toolDefs, toolLabel, runTool } from './chat-tools.js';
import { streamChat } from '../llm-stream.js';
import { resolvePersona } from '../agents/lib/copilot.js';
import { buildRecommendations } from '../agents/lib/recommendations.js';
import { createConversation, getConversation, getRecentMessages, saveMessage } from '../store/copilot.js';

// The Agent chat as one conversation, the way ChatGPT or Gemini work: the answer streams in word by word, and when it needs a fact
// it looks it up (chat-tools.js) mid-answer. Three layers, fastest first:
//
//   1. Fixed answers ("what is AEO?") and questions with one exact answer in the records ("any PR today?", "what is waiting for
//      me?") are answered by assistant.js with NO model call and arrive at once.
//   2. Anything else goes to the model, streamed, with read-only lookup tools. Numbers come from the tools; the model only words
//      them. It sees the earlier messages of the conversation.
//   3. If the model cannot be reached, the person is told so plainly. Nothing is made up.
//
// Events sent through `emit` (the route turns each into a server-sent event):
//   { type: 'status', text }   what it is looking up right now
//   { type: 'delta',  text }   the next piece of the answer
//   { type: 'final',  message, actions, data: { conversationId, citedFindings, followUps } }   the whole answer, once
//   { type: 'error',  message }

export const MAX_TOOL_TURNS = 4;
const HISTORY_MESSAGES = 8;
const MAX_ANSWER_TOKENS = 700;

const CHAT_STYLE = `
You are chatting in a small chat window. Talk the way a sharp colleague does in a message: direct, warm, no filler. Lead with the
answer. Keep it to a few short sentences unless they ask for detail. If they just say hi or thanks, answer in a line.
Rules you never break:
- Every number, date, page and status comes from your lookup tools. If a tool gave you nothing or failed, say so plainly. Never
  estimate or invent.
- Look things up before answering anything about their site, traffic, issues, pull requests, approvals or what the agents did.
  For "how do I use this dashboard" questions, look up the guide.
- If the data comes from an analysis that is more than a day old (the tool tells you), say how old.
- Plain text only. No markdown: no asterisks, no # headings, no backticks. For a list use "1. ", "2. " on separate lines.
- Never name your tools. Never show ids.
- You can read and explain. You cannot approve, publish or change anything from here: for that, say which page to open.
- End with one short, specific suggestion for what they could do or ask next, only when it genuinely helps.`;

export const FRIENDLY_ERROR = 'I could not reach the assistant just now. Please try again in a moment.';
export const EMPTY_ANSWER = 'I could not put an answer together for that. Could you ask it another way?';

// History can start mid-exchange (only the last few messages are kept) and some providers require the first turn to be the
// person's, so any leading assistant turns are dropped.
export function cleanHistory(rows = []) {
  const msgs = rows.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).map((m) => ({ role: m.role, content: String(m.content) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

export async function runStreamingChat({ ctx, message, conversationId = null, emit, signal, deps = {} }) {
  const d = {
    staticAnswer, handleMessage, streamChat, resolvePersona, buildRecommendations, runTool, toolDefs,
    createConversation, getConversation, getRecentMessages, saveMessage, ...deps,
  };

  // Layer 1: answers that need no model.
  const fixed = d.staticAnswer(message);
  if (fixed) return instant(emit, fixed, { fixed: true });
  const quick = await d.handleMessage({ ctx, message, conversationId, deps: { deferAi: true, ...(deps.capDeps || {}) } });
  if (quick && !quick.deferred) {
    emit({ type: 'delta', text: quick.message });
    emit({ type: 'final', message: quick.message, actions: quick.actions || [], data: { ...(quick.data || {}), citedFindings: quick.data?.citedFindings || [], followUps: [] } });
    return;
  }

  // Layer 2: the model, streamed.
  let convo = null;
  let full = '';
  try {
    const [existing, persona] = await Promise.all([
      conversationId ? d.getConversation(ctx.siteId, conversationId).catch(() => null) : null,
      d.resolvePersona(ctx.siteId, ctx.userId),
    ]);
    convo = existing || await d.createConversation(ctx.siteId, message.slice(0, 80));
    const history = cleanHistory(await d.getRecentMessages(convo.id, HISTORY_MESSAGES));
    await d.saveMessage(convo.id, 'user', message);

    const system = `${persona.systemPrompt}\n${CHAT_STYLE}`;
    const messages = [...history, { role: 'user', content: message }];
    const tools = d.toolDefs();
    const cited = new Map();
    let groundedPromise = null;

    for (let turn = 0; turn <= MAX_TOOL_TURNS; turn += 1) {
      if (signal?.aborted) return;
      // The last allowed turn offers no tools, so the model must answer with what it has.
      const res = await d.streamChat({
        system, messages, tools: turn === MAX_TOOL_TURNS ? [] : tools, maxTokens: MAX_ANSWER_TOKENS, signal,
        onText: (t) => { full += t; emit({ type: 'delta', text: t }); },
      });
      if (signal?.aborted) return; // the chat was closed mid-answer: nothing partial is saved or sent
      if (!res.toolCalls?.length) break;

      messages.push({
        role: 'assistant', content: res.text || null,
        tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
      });
      // Anything said before a lookup stays; the next words start a new paragraph.
      if (res.text && !/\s$/.test(full)) { full += '\n\n'; emit({ type: 'delta', text: '\n\n' }); }
      for (const c of res.toolCalls) emit({ type: 'status', text: toolLabel(c.name) });
      if (res.toolCalls.some((c) => c.name === 'get_findings')) groundedPromise ||= d.buildRecommendations(ctx.siteId).catch(() => ({ items: [] }));

      const results = await Promise.all(res.toolCalls.map((c) => d.runTool(c.name, c.args, ctx, deps.toolDeps)));
      res.toolCalls.forEach((c, i) => {
        messages.push({ role: 'tool', tool_call_id: c.id, content: results[i].content });
        for (const f of results[i].cited || []) cited.set(f.id, f);
      });
    }

    const answer = full.trim() || EMPTY_ANSWER;
    // Same real-actionability check Action Center's own list uses, so a cited finding only gets "Generate draft" when it can have one.
    const grounded = groundedPromise ? await groundedPromise : { items: [] };
    const byId = new Map((grounded.items || []).map((item) => [item.id, item]));
    const citedFindings = [...cited.values()].map((f) => {
      const item = byId.get(f.id);
      return { ...f, actionable: item ? { generatorId: item.generatorId, params: item.params, tag: item.tag, source: item.source } : null };
    });
    await d.saveMessage(convo.id, 'assistant', answer, { citedFindingIds: citedFindings.map((f) => f.id) }).catch(() => {});
    emit({ type: 'final', message: answer, actions: [], data: { conversationId: convo.id, citedFindings, followUps: [] } });
  } catch (err) {
    if (signal?.aborted) return;
    console.warn('[chat] streaming answer failed:', err?.message || err);
    // Words already shown stay on screen; the person is told the rest did not arrive.
    emit({ type: 'error', message: FRIENDLY_ERROR, partial: Boolean(full.trim()), conversationId: convo?.id || null });
  }
}

function instant(emit, message, data) {
  emit({ type: 'delta', text: message });
  emit({ type: 'final', message, actions: [], data: { ...data, citedFindings: [], followUps: [] } });
}
