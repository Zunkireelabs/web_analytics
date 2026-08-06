import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getLessons } from './lessons.js';

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

// Prepends any recorded fix_lessons (migration 086) for this generator as a
// "known issues" block on the system prompt — so a mistake class already
// corrected once (by a person or a prior fix) doesn't have to be
// re-explained every time it resurfaces on a new page/site. Silently
// no-ops (falls back to the plain system prompt) if the lookup itself
// fails — a lessons-table outage must never break drafting.
async function withLessons(system, generatorId, siteId) {
  if (!generatorId) return system;
  let lessons;
  try {
    lessons = await getLessons(generatorId, siteId);
  } catch (err) {
    console.warn(`[llm] fix_lessons lookup failed for "${generatorId}", continuing without it: ${err.message}`);
    return system;
  }
  if (!lessons.length) return system;
  const block = lessons.map((l) => `- ${l.title}: ${l.lesson}`).join('\n');
  return `${system}\n\nKnown issues from past fixes — do not repeat these:\n${block}`;
}

// Calls the chosen LLM with a system + user prompt and returns plain text.
// `model` overrides the resolved default outright; `tier` picks which
// REPORT_MODEL_* env var / built-in default to fall back to otherwise.
// `generatorId` (+ optional `siteId`) opts into the fix_lessons prompt
// injection above — pass the calling generator's own meta.id.
export async function callLLM(system, user, { model, maxTokens = 500, tier = 'daily', generatorId, siteId } = {}) {
  system = await withLessons(system, generatorId, siteId);
  const provider = pickProvider();
  const envVar = tier === 'monthly' ? 'REPORT_MODEL_MONTHLY' : 'REPORT_MODEL_DAILY';
  const resolvedModel = model || process.env[envVar] || MODEL_DEFAULTS[provider][tier];

  if (provider === 'openai') {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
export async function callLLMForJson(system, user, options = {}) {
  const raw = await callLLM(system, user, options);
  const parsed = extractJson(raw);
  if (parsed !== null) return parsed;

  console.warn('[llm] first response was not valid JSON, retrying once with a corrective nudge…');
  const retryUser = `${user}\n\nYour previous response was not valid JSON. Respond with ONLY the raw JSON — no markdown code fences, no explanation, no text before or after it.`;
  const retryRaw = await callLLM(system, retryUser, options);
  const retryParsed = extractJson(retryRaw);
  if (retryParsed !== null) return retryParsed;

  throw Object.assign(new Error('Model did not return valid JSON after 2 attempts.'), { status: 400 });
}
