import OpenAI from 'openai';
import { buildExtractionPrompt, parseExtractionResponse } from './extraction-prompt.js';
import { domainsFromUrls } from './citations.js';

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

// Whether probes run with live web search, like the ChatGPT app a real buyer
// uses. OPT-IN (AI_RECOMMENDATION_WEB_SEARCH=true) because every search call
// is billed on top of the model tokens, and the daily agent can make many.
// Left off, the probe only tests what the model remembers from training,
// which reported 0 mentions out of 30 prompts for zunkireelabs.com
// (2026-10-13) while the ChatGPT app ranked it #2 for a comparable question —
// so treat memory-only results as a weak signal and turn this on for a small,
// deliberate check.
export function webSearchEnabled() {
  return process.env.AI_RECOMMENDATION_WEB_SEARCH === 'true';
}

// The URLs a web-search answer showed as citations (url_citation annotations on the message), and separately every URL
// the search consulted (web_search_call.action.sources, only present when the request asks for it with `include`).
// Citations are what a reader of the answer sees, so they are what gets stored and checked; sources are kept for
// reporting how many pages were read. Pure, so it is testable without a network call.
export function citationsFromResponse(res) {
  const cited = [];
  const consulted = [];
  for (const item of res?.output || []) {
    for (const part of item?.content || []) {
      for (const a of part?.annotations || []) {
        if (a?.type === 'url_citation' && a.url) cited.push(a.url);
      }
    }
    if (item?.type === 'web_search_call') {
      for (const src of item?.action?.sources || []) if (src?.url) consulted.push(src.url);
    }
  }
  return { citedUrls: [...new Set(cited)], sourceUrls: [...new Set(consulted)] };
}

// Pulls the answer text out of a Responses API result and appends the URLs it
// cited as sources, so a citation of the company's own domain is visible to
// the deterministic mention check even when its name is not in the prose.
// Pure, so it is testable without a network call.
export function textFromResponse(res) {
  const text = (res?.output_text || '').trim();
  const { citedUrls } = citationsFromResponse(res);
  return citedUrls.length ? `${text}\n\nSources:\n${citedUrls.join('\n')}` : text;
}

// The current Responses API web search tool. 'web_search_preview' (what this used before 2026-11-18) is legacy: OpenAI
// bills it at $25 per 1,000 calls for non-reasoning models against $10 for 'web_search' (plus a fixed 8,000 input
// tokens per call for gpt-4o-mini / gpt-4.1-mini). The env var exists only to switch back if 'web_search' is refused.
const WEB_SEARCH_TOOL = process.env.AI_RECOMMENDATION_WEB_SEARCH_TOOL || 'web_search';

// The two request bodies a probe can send (web search through the Responses API, memory-only through Chat
// Completions). `country` ({iso, name}, from site-locations.js probeCountry) says where the asker is. The ChatGPT app
// knows a user's approximate location and answers for it, so a UK buyer asking "removals companies for elderly people"
// gets UK firms; an API call with no location answers as if from the US (Chayce, a UK-only client, was 0 of 15 on
// 2026-09-14 and 2026-11-05 with every named company American). The hint says only where the asker is, never anything
// about the client, so it does not steer the answer towards or away from anyone. No country = byte-for-byte the old
// request. Pure, so it is testable without a network call.
export function buildProbeRequest(prompt, { country = null } = {}) {
  const webSearchTool = { type: WEB_SEARCH_TOOL };
  if (country?.iso) webSearchTool.user_location = { type: 'approximate', country: country.iso };
  const messages = [{ role: 'user', content: prompt }];
  if (country?.name) messages.unshift({ role: 'system', content: `The user is located in ${country.name}.` });
  return {
    responses: { model: MODEL, max_output_tokens: 900, tools: [webSearchTool], include: ['web_search_call.action.sources'], input: prompt },
    chat: { model: MODEL, max_tokens: 600, messages },
  };
}

// Sends `prompt` exactly as a real user would ask it — no system prompt
// steering the answer, since the whole point is observing what the model
// would naturally say unprompted (the only addition is where the asker is,
// see buildProbeRequest). Returns the raw text verbatim; callers
// (server/agents/ai-recommendation.js) verify facts about it in JS rather
// than trusting any self-report from a second call.
export async function ask(prompt, { country = null } = {}) {
  if (!configured()) throw new Error('OPENAI_API_KEY is not set — AI Recommendation probes cannot run.');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const request = buildProbeRequest(prompt, { country });
  if (webSearchEnabled()) {
    try {
      const res = await client.responses.create(request.responses);
      const raw = textFromResponse(res);
      if (raw) {
        const { citedUrls, sourceUrls } = citationsFromResponse(res);
        // An empty list is a real result (it searched and cited nothing); null would mean "this probe cannot cite".
        return { raw, model: `${MODEL}+web-search`, citedDomains: domainsFromUrls(citedUrls), sourcesConsulted: sourceUrls.length };
      }
    } catch (err) {
      console.warn('[ai-recommendation] web-search probe failed, falling back to memory-only:', err.message);
    }
  }
  const res = await client.chat.completions.create(request.chat);
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
