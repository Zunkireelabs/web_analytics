import OpenAI from 'openai';
import { buildExtractionPrompt, parseExtractionResponse } from './extraction-prompt.js';

// Perplexity's Sonar API is OpenAI-SDK-compatible (same client, different
// baseURL/key) — reusing the `openai` package instead of a bespoke HTTP
// client, same "don't hand-roll what a maintained SDK already does" reason
// this codebase reuses `openai` for both providers it fronts today.
//
// Unlike OpenAI/Anthropic, Perplexity's real responses include `citations`/
// `search_results` — the actual source URLs the model grounded its answer
// in. `ask()` below captures them into the return value now (Phase 1) even
// though nothing reads that field yet — the later citation-source-capture
// phase is what will use it, and wiring the capture at the same time as the
// provider avoids a second pass through this file for a one-line change.

export const id = 'perplexity';

// Same double-opt-in shape as anthropic.js: the master AI_RECOMMENDATION_ENABLED
// gate, a real key, AND this provider's own dedicated flag. Perplexity isn't
// used anywhere else in this codebase, so there's no existing key to
// accidentally reuse — the dedicated flag is kept anyway for symmetry with
// every other provider here and to make activation always explicit.
export function configured() {
  return process.env.AI_RECOMMENDATION_ENABLED === 'true'
    && !!process.env.PERPLEXITY_API_KEY
    && process.env.AI_RECOMMENDATION_PERPLEXITY_ENABLED === 'true';
}

const MODEL = process.env.AI_RECOMMENDATION_PERPLEXITY_MODEL || 'sonar';

function client() {
  return new OpenAI({ apiKey: process.env.PERPLEXITY_API_KEY, baseURL: 'https://api.perplexity.ai' });
}

// Sends `prompt` exactly as a real user would ask it — no system prompt
// steering the answer, same "observe what it says unprompted" design as
// every other provider here. `citations`/`searchResults` are real fields
// from Perplexity's own response when present, never fabricated if absent.
export async function ask(prompt) {
  if (!configured()) throw new Error('PERPLEXITY_API_KEY / AI_RECOMMENDATION_PERPLEXITY_ENABLED are not both set — AI Recommendation Perplexity probes cannot run.');
  const res = await client().chat.completions.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });
  return {
    raw: res.choices[0]?.message?.content?.trim() || '',
    model: MODEL,
    citations: res.citations || [],
    searchResults: res.search_results || [],
  };
}

// Structured-extraction pass over an already-real raw response — same
// discipline as every other provider's extract(): only the qualitative/soft
// fields here are trusted from this call; `mentioned` is verified
// separately and deterministically in JS by the caller.
export async function extract(rawResponse, { companyName, domain }) {
  if (!configured()) throw new Error('PERPLEXITY_API_KEY / AI_RECOMMENDATION_PERPLEXITY_ENABLED are not both set — AI Recommendation Perplexity probes cannot run.');
  const res = await client().chat.completions.create({
    model: MODEL,
    max_tokens: 300,
    messages: [
      { role: 'system', content: buildExtractionPrompt(companyName, domain) },
      { role: 'user', content: `Response text:\n${rawResponse}` },
    ],
  });
  return parseExtractionResponse(res.choices[0]?.message?.content?.trim());
}
