import Anthropic from '@anthropic-ai/sdk';
import { buildExtractionPrompt, parseExtractionResponse } from './extraction-prompt.js';

// Dedicated Anthropic/Claude client for the AI Recommendation Agent's real
// prompt probes — same reasoning as openai.js: this needs "always Claude,
// regardless of what server/llm.js's global REPORT_PROVIDER switch resolves
// to for narratives elsewhere," which callLLM has no per-call way to
// express, so this bypasses it with its own dedicated client, same as the
// OpenAI provider.

export const id = 'anthropic';

// ANTHROPIC_API_KEY already exists in most deployments for the unrelated
// daily-narrative/callLLM feature (server/llm.js) — reusing it here without
// a dedicated flag would silently activate real, costed Claude probe calls
// for anyone who already had that key configured for something else. Three
// conditions, not two: the master AI_RECOMMENDATION_ENABLED gate (this
// agent's feature switch), a real key, AND this provider's own dedicated
// flag — so turning on OpenAI probing (or narratives) never silently turns
// on paid Claude probing too.
export function configured() {
  return process.env.AI_RECOMMENDATION_ENABLED === 'true'
    && !!process.env.ANTHROPIC_API_KEY
    && process.env.AI_RECOMMENDATION_ANTHROPIC_ENABLED === 'true';
}

const MODEL = process.env.AI_RECOMMENDATION_ANTHROPIC_MODEL || 'claude-haiku-4-5';

// Sends `prompt` exactly as a real user would ask it — no system prompt
// steering the answer, matching the OpenAI probe's "observe what it says
// unprompted" design. Returns the raw text verbatim; callers verify facts
// about it in JS rather than trusting any self-report from a second call.
export async function ask(prompt) {
  if (!configured()) throw new Error('ANTHROPIC_API_KEY / AI_RECOMMENDATION_ANTHROPIC_ENABLED are not both set — AI Recommendation Claude probes cannot run.');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  return { raw, model: MODEL };
}

// Structured-extraction pass over an already-real raw response — same
// discipline as openai.js's extract(): only the qualitative/soft fields
// here are trusted from this call; `mentioned` is verified separately and
// deterministically in JS by the caller via a real string/domain match.
export async function extract(rawResponse, { companyName, domain }) {
  if (!configured()) throw new Error('ANTHROPIC_API_KEY / AI_RECOMMENDATION_ANTHROPIC_ENABLED are not both set — AI Recommendation Claude probes cannot run.');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: buildExtractionPrompt(companyName, domain),
    messages: [{ role: 'user', content: `Response text:\n${rawResponse}` }],
  });
  const raw = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  return parseExtractionResponse(raw);
}
