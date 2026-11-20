import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { LLM_TIMEOUT_MS, MODEL_DEFAULTS, openAiRoute, noteOpenAiQuotaExhausted, noteOpenAiHealthy, fallbackAvailable, isQuotaExhaustedError } from '../../llm.js';

// A chat client for agentic-orchestrator.js's tool-calling loop that looks exactly like the OpenAI SDK's
// `client.chat.completions.create(params)` (same params in, same response shape out), so the loop is unchanged, but which provider
// answers is decided here.
//
// OpenAI is used while it works. When it reports an exhausted quota (llm.js's isQuotaExhaustedError) and an Anthropic key is set, the
// same request is answered by Claude through its tool-use API, and the shared breaker in llm.js keeps later calls on Claude until a
// probe shows OpenAI works again — the same automatic switch-back callLLM has. Without an Anthropic key nothing changes.

const realOpenAiKey = (env) => Boolean(env.OPENAI_API_KEY) && !env.OPENAI_API_KEY.startsWith('sk-xxxx');

export function anthropicModel(env = process.env) {
  return env.AGENTIC_ORCHESTRATION_ANTHROPIC_MODEL || MODEL_DEFAULTS.anthropic.daily;
}

// OpenAI tool definitions -> Anthropic's.
export function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters && t.function.parameters.type ? t.function.parameters : { type: 'object', properties: {} },
  }));
}

const parseArgs = (raw) => { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

// OpenAI-format messages -> { system, messages } for Anthropic. System messages become the system prompt; an assistant message's
// tool_calls become tool_use blocks; consecutive tool results (and any user text after them) become ONE user turn with the
// tool_result blocks first, which is what Anthropic requires.
export function toAnthropicRequest(messages) {
  const system = [];
  const out = [];
  const pushUser = (blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === 'user') last.content.push(...blocks);
    else out.push({ role: 'user', content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'system') { if (m.content) system.push(String(m.content)); continue; }
    if (m.role === 'user') { pushUser([{ type: 'text', text: String(m.content ?? '') }]); continue; }
    if (m.role === 'tool') { pushUser([{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }]); continue; }
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const tc of m.tool_calls || []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    }
  }
  // tool_result blocks must lead a user turn that follows a tool_use.
  for (const m of out) if (m.role === 'user') m.content.sort((a, b) => (b.type === 'tool_result') - (a.type === 'tool_result'));
  return { system: system.join('\n\n'), messages: out };
}

// Anthropic response -> the OpenAI response shape the loop reads.
export function fromAnthropicResponse(msg) {
  const blocks = msg?.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const toolCalls = blocks.filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
  return {
    choices: [{ message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
    usage: { prompt_tokens: msg?.usage?.input_tokens || 0, completion_tokens: msg?.usage?.output_tokens || 0 },
  };
}

const hasToolBlocks = (messages) => messages.some((m) => m.role === 'assistant' && m.tool_calls?.length);

export function makeAgenticClient({ openai, anthropic, env = process.env } = {}) {
  const oa = openai ?? (realOpenAiKey(env) ? new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: LLM_TIMEOUT_MS }) : null);
  let claude = anthropic ?? null;
  const getClaude = () => (claude ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: LLM_TIMEOUT_MS }));
  let lastTools = null; // the final "answer now" call omits tools, but Claude needs them while the history holds tool_use blocks

  const viaAnthropic = async (params) => {
    if (params.tools?.length) lastTools = params.tools;
    const { system, messages } = toAnthropicRequest(params.messages);
    const tools = params.tools?.length ? params.tools : (hasToolBlocks(params.messages) ? lastTools : null);
    const req = { model: anthropicModel(env), max_tokens: params.max_tokens || 500, messages, ...(system ? { system } : {}) };
    if (tools?.length) {
      req.tools = toAnthropicTools(tools);
      req.tool_choice = params.tools?.length ? { type: 'auto' } : { type: 'none' };
    }
    return fromAnthropicResponse(await getClaude().messages.create(req));
  };

  return {
    chat: {
      completions: {
        create: async (params) => {
          // No usable OpenAI key but an Anthropic one: answer with Claude.
          if (!oa) {
            if (!env.ANTHROPIC_API_KEY && !anthropic) throw new Error('No LLM key configured for the agentic loop.');
            return viaAnthropic(params);
          }
          if (params.tools?.length) lastTools = params.tools;
          if (openAiRoute(Date.now(), env) === 'fallback') return viaAnthropic(params);
          try {
            const res = await oa.chat.completions.create(params);
            noteOpenAiHealthy();
            return res;
          } catch (err) {
            if ((anthropic || fallbackAvailable(env)) && isQuotaExhaustedError(err)) {
              noteOpenAiQuotaExhausted(err);
              return viaAnthropic(params);
            }
            throw err;
          }
        },
      },
    },
  };
}
