import OpenAI from 'openai';
import { buildExtractionPrompt, parseExtractionResponse } from './extraction-prompt.js';

// Dedicated OpenAI client for the AI Recommendation Agent's real prompt
// probes — deliberately NOT routed through server/llm.js's callLLM().
// callLLM's provider choice is a single global switch (REPORT_PROVIDER /
// OPENAI_API_KEY), used by every other agent's narrative call; this agent
// needs "always OpenAI in Phase 1, regardless of what that switch resolves
// to for everything else," which callLLM has no per-call way to express.
//
// Kept in its own model-providers/ directory (not a one-off inline call) so
// Anthropic/Perplexity (see sibling files) implement the same
// `id`/`configured()`/`ask(prompt) -> {raw, model}`/`extract(raw, {companyName,
// domain})` shape, with zero schema change — ai_prompt_runs.model (migration
// 036) is already free text, and ai_prompt_runs.provider (migration 075)
// records which of these this row actually came from.

export const id = 'openai';

// Deliberately NOT just "is OPENAI_API_KEY set" — that key already exists
// in most deployments of this app for the unrelated daily-narrative
// feature (server/llm.js), so reusing it here would silently activate real,
// costed OpenAI probe calls for anyone who already had that key configured
// for something else, with no explicit opt-in to this specific feature.
// AI_RECOMMENDATION_ENABLED is this agent's own dedicated gate — both must
// be true before a single real probe call is made.
export function configured() {
  return !!process.env.OPENAI_API_KEY && process.env.AI_RECOMMENDATION_ENABLED === 'true';
}

const MODEL = process.env.AI_RECOMMENDATION_MODEL || 'gpt-4o-mini';

// Sends `prompt` exactly as a real user would ask it — no system prompt
// steering the answer, since the whole point is observing what the model
// would naturally say unprompted. Returns the raw text verbatim; callers
// (server/agents/ai-recommendation.js) verify facts about it in JS rather
// than trusting any self-report from a second call.
export async function ask(prompt) {
  if (!configured()) throw new Error('OPENAI_API_KEY is not set — AI Recommendation probes cannot run.');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });
  return { raw: res.choices[0]?.message?.content?.trim() || '', model: MODEL };
}

// Structured-extraction pass over an already-real raw response — asks the
// model to parse (not generate) facts about text that already exists. Only
// the qualitative/soft fields below are trusted from this call;
// `mentioned` is verified separately and deterministically in JS by the
// caller via a real string/domain match, never taken from this extraction.
export async function extract(rawResponse, { companyName, domain }) {
  if (!configured()) throw new Error('OPENAI_API_KEY is not set — AI Recommendation probes cannot run.');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 300,
    messages: [
      { role: 'system', content: buildExtractionPrompt(companyName, domain) },
      { role: 'user', content: `Response text:\n${rawResponse}` },
    ],
  });
  return parseExtractionResponse(res.choices[0]?.message?.content?.trim());
}
