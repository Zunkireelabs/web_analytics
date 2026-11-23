import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  resolveProviderAndModel, openAiRoute, noteOpenAiQuotaExhausted, noteOpenAiHealthy, fallbackAvailable,
  isQuotaExhaustedError, recordLlmUsage, LLM_TIMEOUT_MS, MODEL_DEFAULTS,
} from './llm.js';
import { toAnthropicTools } from './agents/lib/agentic-client.js';

// A streaming chat turn with tool calling, for the Agent chat. One call = one model turn: the text arrives in pieces through
// `onText` as the model writes it (so the first words show in about a second), and the call resolves with the whole text plus
// any tool calls the model asked for. The caller runs the tools and calls again; see assistant/chat-stream.js.
//
// Provider choice, models and the OpenAI -> Claude quota fallback are the same ones callLLM uses (llm.js), so chat and every
// generator switch providers together. A streamed reply cannot be retried once words have been shown, so the only automatic
// switch is the quota fallback, and only while nothing has been shown yet. Any other failure is thrown to the caller.
//
// params: { system, messages (OpenAI format: user / assistant{tool_calls} / tool), tools (OpenAI function defs), maxTokens, onText, signal }
// deps:   { clients: { openai, anthropic } (tests), env }
// returns { text, toolCalls: [{ id, name, args }], provider, model }

const parseArgs = (raw) => { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

export async function streamChat({ system, messages, tools = [], maxTokens = 700, onText = () => {}, signal } = {}, { clients = {}, env = process.env } = {}) {
  let shown = 0;
  const emit = (t) => { if (t) { shown += t.length; onText(t); } };
  const { provider, model } = resolveProviderAndModel({ tier: 'daily', env });
  const anthropicModel = MODEL_DEFAULTS.anthropic.daily;

  if (provider === 'openai') {
    if (openAiRoute(Date.now(), env) === 'fallback') {
      return runAnthropic({ system, messages, tools, maxTokens, emit, signal, model: anthropicModel, fallback: true }, clients, env);
    }
    try {
      const out = await runOpenAi({ system, messages, tools, maxTokens, emit, signal, model }, clients, env);
      noteOpenAiHealthy();
      return out;
    } catch (err) {
      if (shown === 0 && fallbackAvailable(env) && isQuotaExhaustedError(err)) {
        noteOpenAiQuotaExhausted(err);
        return runAnthropic({ system, messages, tools, maxTokens, emit, signal, model: anthropicModel, fallback: true }, clients, env);
      }
      throw err;
    }
  }
  return runAnthropic({ system, messages, tools, maxTokens, emit, signal, model, fallback: false }, clients, env);
}

async function runOpenAi({ system, messages, tools, maxTokens, emit, signal, model }, clients, env) {
  const client = clients.openai || new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: LLM_TIMEOUT_MS });
  const stream = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, ...messages],
    ...(tools.length ? { tools } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }, signal ? { signal } : undefined);

  let text = '';
  let usage = null;
  const calls = new Map(); // tool calls arrive in fragments keyed by index
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) { text += delta.content; emit(delta.content); }
    for (const tc of delta.tool_calls || []) {
      const c = calls.get(tc.index) || { id: '', name: '', args: '' };
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name = tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
      calls.set(tc.index, c);
    }
  }
  // The OpenAI SDK ends a stream QUIETLY when its signal aborts (no error), so without this a half-written answer would be
  // returned as if it were complete.
  if (signal?.aborted) throw Object.assign(new Error('The request was aborted.'), { name: 'AbortError' });
  recordLlmUsage({ provider: 'openai', model, usage });
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c], i) => ({ id: c.id || `call_${i}`, name: c.name, args: parseArgs(c.args) }));
  return { text, toolCalls: toolCalls.filter((c) => c.name), provider: 'openai', model };
}

async function runAnthropic({ system, messages, tools, maxTokens, emit, signal, model, fallback }, clients, env) {
  const client = clients.anthropic || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: LLM_TIMEOUT_MS });
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system,
    messages: toAnthropicMessages(messages),
    ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
  }, signal ? { signal } : undefined);
  stream.on('text', (t) => emit(t));
  const final = await stream.finalMessage();
  recordLlmUsage({ provider: 'anthropic', model, usage: final?.usage, fallback });
  const blocks = final?.content || [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input && typeof b.input === 'object' ? b.input : {} })),
    provider: 'anthropic', model,
  };
}

// OpenAI-format turns -> Anthropic's. Same rules as agentic-client.js's toAnthropicRequest (tool results go in a user turn,
// first), minus the system message, which is passed separately above.
export function toAnthropicMessages(messages) {
  const out = [];
  const pushUser = (blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === 'user') last.content.push(...blocks);
    else out.push({ role: 'user', content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'user') pushUser([{ type: 'text', text: String(m.content ?? '') }]);
    else if (m.role === 'tool') pushUser([{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }]);
    else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const tc of m.tool_calls || []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    }
  }
  for (const m of out) if (m.role === 'user') m.content.sort((a, b) => (b.type === 'tool_result') - (a.type === 'tool_result'));
  return out;
}
