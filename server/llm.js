import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { withAgentMemory } from './agent-memory.js';
import { withDesignContext } from './implementers/lib/design-drift.js';

// Shared LLM helper used by both the daily narrative and the weekly doc report.
// Provider is chosen automatically: a real OPENAI_API_KEY → OpenAI, else Anthropic.
// Force with REPORT_PROVIDER=openai|anthropic.
export function pickProvider() {
  if (process.env.REPORT_PROVIDER) return process.env.REPORT_PROVIDER.toLowerCase();
  const oa = process.env.OPENAI_API_KEY;
  if (oa && !oa.startsWith('sk-xxxx')) return 'openai';
  return 'anthropic';
}

// Transient upstream failures (rate limits, 5xx, dropped connections) are
// worth one retry — a bare `throw` on the first hiccup is what turned into a
// raw 500 for a user clicking a generator button during the product audit.
// Non-retryable errors (bad request, auth, etc.) fail immediately.
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

// Both SDKs default to a multi-minute timeout, so a connection that stalls
// without erroring (rather than cleanly failing) can hold a caller open for
// a very long time — e.g. Run Full Analysis awaiting ~19 parallel agents,
// several of which make LLM calls. Exported so agentic-orchestrator.js's
// own `new OpenAI(...)` client gets the same ceiling.
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60_000;

export function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429 || status >= 500) return true;
  if (!status && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err?.code)) return true;
  return false;
}

// Exported so other direct OpenAI/Anthropic callers (e.g. agentic-orchestrator.js's
// tool-calling loop) get the same one-retry-on-transient-failure behavior as callLLM,
// instead of reimplementing it.
export async function withRetry(fn) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_ATTEMPTS || !isRetryable(err)) throw err;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[llm] attempt ${attempt} failed (${err.message}), retrying in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// `REPORT_MODEL_MONTHLY` has always been documented in .env.example for
// "the monthly model" (a stronger tier for infrequent, higher-stakes calls)
// but was never actually read anywhere — every call silently used the cheap
// daily-tier model. `tier: 'monthly'` completes that: for calls where model
// world-knowledge matters more than per-call cost (e.g. weekly competitor
// discovery, where a cheap model reliably misses real, niche local
// companies), pass tier: 'monthly' to use the stronger default.
export const MODEL_DEFAULTS = {
  openai: { daily: 'gpt-4o-mini', monthly: 'gpt-4o' },
  anthropic: { daily: 'claude-haiku-4-5', monthly: 'claude-opus-4-8' },
};

// Calls the chosen LLM with a system + user prompt and returns plain text.
// `model` overrides the resolved default outright; `tier` picks which
// REPORT_MODEL_* env var / built-in default to fall back to otherwise.
// `generatorId` (+ optional `siteId`) opts into the shared agent_fix_memory
// prompt injection (server/agent-memory.js's withAgentMemory) — pass the
// calling generator's own meta.id. This is the automatic RETRIEVE step of
// the platform-wide learning loop: every generator gets it for free just by
// passing its own id, with no separate opt-in per generator.
export async function callLLM(system, user, { model, maxTokens = 500, tier = 'daily', generatorId, siteId } = {}) {
  system = await withAgentMemory(system, generatorId, siteId);
  // Shared design-intelligence layer (server/implementers/lib/design-drift.js) —
  // real site design/voice grounding for every website-facing generator, the
  // same automatic-by-generatorId shape as withAgentMemory just above. A
  // no-op for generatorIds outside DESIGN_CONTEXT_GENERATOR_IDS (purely
  // technical output) and for any site without a usable Design Context yet.
  system = await withDesignContext(system, generatorId, siteId);
  const provider = pickProvider();
  const envVar = tier === 'monthly' ? 'REPORT_MODEL_MONTHLY' : 'REPORT_MODEL_DAILY';
  const resolvedModel = model || process.env[envVar] || MODEL_DEFAULTS[provider][tier];

  if (provider === 'openai') {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: LLM_TIMEOUT_MS });
    const res = await withRetry(() => openai.chat.completions.create({
      model: resolvedModel,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }));
    return res.choices[0]?.message?.content?.trim() || '';
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: LLM_TIMEOUT_MS });
  const msg = await withRetry(() => anthropic.messages.create({
    model: resolvedModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }));
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}

// Strips a markdown code fence wrapper (```json ... ``` or ``` ... ```) if
// present — models frequently wrap JSON in one despite an explicit
// "respond with ONLY JSON" instruction.
function stripCodeFence(raw) {
  return raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
}

// Best-effort JSON extraction: a direct parse first, then (if the model
// added stray prose before/after the JSON despite instructions not to) the
// widest {...}/[...] substring in the response. Returns null, never throws
// — callers decide what "still no valid JSON" means for them.
export function extractJson(raw) {
  const stripped = stripCodeFence(raw || '');
  try { return JSON.parse(stripped); } catch { /* fall through to substring extraction */ }
  const firstBrace = stripped.search(/[{[]/);
  const lastBrace = Math.max(stripped.lastIndexOf('}'), stripped.lastIndexOf(']'));
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  try { return JSON.parse(stripped.slice(firstBrace, lastBrace + 1)); } catch { return null; }
}

// callLLM, but for a JSON-shaped response — a distinct failure mode from
// the transient network/5xx retry callLLM already does internally: the
// HTTP call succeeds, but the model's actual text content isn't parseable
// JSON (stray prose, truncation, or just missing the mark despite an
// explicit "respond with ONLY JSON" instruction). Confirmed as a real,
// recurring failure across multiple generators (schema/faq/expand-content/
// meta-title/...), not a one-off — one retry with a sharper, explicit
// correction appended to the prompt before giving up honestly.
//
// `validate` (optional) extends the same one-retry treatment to a parsed
// response with the wrong *shape* (e.g. an object where an array was
// required) — without it, a caller that parses fine but fails a shape check
// downstream never gets the corrective-nudge retry at all, only the raw
// "not valid JSON" one. Defaults to accept-anything so existing callers are
// unaffected.
export async function callLLMForJson(system, user, options = {}) {
  const { validate = () => true, ...llmOptions } = options;
  const raw = await callLLM(system, user, llmOptions);
  const parsed = extractJson(raw);
  if (parsed !== null && validate(parsed)) return parsed;

  console.warn('[llm] first response was not valid JSON (or failed shape validation), retrying once with a corrective nudge…');
  const retryUser = `${user}\n\nYour previous response was not valid JSON. Respond with ONLY the raw JSON — no markdown code fences, no explanation, no text before or after it.`;
  const retryRaw = await callLLM(system, retryUser, llmOptions);
  const retryParsed = extractJson(retryRaw);
  if (retryParsed !== null && validate(retryParsed)) return retryParsed;

  throw Object.assign(new Error('Model did not return valid JSON after 2 attempts.'), { status: 400 });
}
