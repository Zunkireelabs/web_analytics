import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// Shared LLM helper used by both the daily narrative and the weekly doc report.
// Provider is chosen automatically: a real OPENAI_API_KEY → OpenAI, else Anthropic.
// Force with REPORT_PROVIDER=openai|anthropic.
function pickProvider() {
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

function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429 || status >= 500) return true;
  if (!status && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err?.code)) return true;
  return false;
}

async function withRetry(fn) {
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
const MODEL_DEFAULTS = {
  openai: { daily: 'gpt-4o-mini', monthly: 'gpt-4o' },
  anthropic: { daily: 'claude-haiku-4-5', monthly: 'claude-opus-4-8' },
};

// Calls the chosen LLM with a system + user prompt and returns plain text.
// `model` overrides the resolved default outright; `tier` picks which
// REPORT_MODEL_* env var / built-in default to fall back to otherwise.
export async function callLLM(system, user, { model, maxTokens = 500, tier = 'daily' } = {}) {
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
