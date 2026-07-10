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

// Calls the chosen LLM with a system + user prompt and returns plain text.
// `model` overrides the default for that provider (e.g. the monthly model).
export async function callLLM(system, user, { model, maxTokens = 500 } = {}) {
  const provider = pickProvider();
  if (provider === 'openai') {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await withRetry(() => openai.chat.completions.create({
      model: model || process.env.REPORT_MODEL_DAILY || 'gpt-4o-mini',
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
    model: model || process.env.REPORT_MODEL_DAILY || 'claude-haiku-4-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }));
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}
