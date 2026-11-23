import Anthropic from '@anthropic-ai/sdk';
import { buildExtractionPrompt, parseExtractionResponse } from './extraction-prompt.js';
import { domainsFromUrls } from './citations.js';

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
// The request body for a probe. `country` ({iso, name}, from site-locations.js probeCountry) says where the asker is,
// the same hint openai.js gives (see buildProbeRequest there for why): only where the user is, nothing about the client.
// No country = exactly the old request. Pure, so it is testable without a network call.
export function buildProbeRequest(prompt, { country = null, webSearch = webSearchEnabled() } = {}) {
  const body = { model: MODEL, max_tokens: webSearch ? 1500 : 600, messages: [{ role: 'user', content: prompt }] };
  if (country?.name) body.system = `The user is located in ${country.name}.`;
  if (webSearch) {
    // Claude with live web search, like the Claude app a real buyer uses. The basic server tool: the newer
    // web_search_20260209 needs a newer model than the default haiku, and a refused tool type fails the whole probe.
    const tool = { type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: 3 };
    if (country?.iso) tool.user_location = { type: 'approximate', country: country.iso };
    body.tools = [tool];
  }
  return body;
}

// Whether probes search the web, like the Claude app does. OPT-IN (AI_RECOMMENDATION_ANTHROPIC_WEB_SEARCH=true) because
// every search is billed on top of the tokens and the daily agent makes many. Off, the probe only tests what the model
// remembers from training, which says nothing about what a buyer sees in the app. Same switch design as openai.js.
export function webSearchEnabled() {
  return process.env.AI_RECOMMENDATION_ANTHROPIC_WEB_SEARCH === 'true';
}
const WEB_SEARCH_TOOL = process.env.AI_RECOMMENDATION_ANTHROPIC_WEB_SEARCH_TOOL || 'web_search_20250305';

// The answer text, plus the URLs the answer cited. Web search answers carry their citations on the text blocks
// (`citations[].url`); the search's own result list is kept separate (a failed search is a result block with an error
// object, not a thrown error, so it is never read as a list). Citations are what a reader of the answer sees, so they
// are what is stored and checked. Pure, so it is testable without a network call.
export function answerFromMessage(msg) {
  const cited = [];
  const texts = [];
  for (const b of msg?.content || []) {
    if (b?.type !== 'text') continue;
    texts.push(b.text);
    for (const c of b.citations || []) if (c?.url) cited.push(c.url);
  }
  const citedUrls = [...new Set(cited)];
  const text = texts.join('').trim();
  // The cited URLs are appended, as openai.js does, so a citation of the company's own domain is visible to the
  // deterministic mention check even when its name is not in the prose.
  return { raw: citedUrls.length ? `${text}\n\nSources:\n${citedUrls.join('\n')}` : text, citedUrls };
}

export async function ask(prompt, { country = null } = {}) {
  if (!configured()) throw new Error('ANTHROPIC_API_KEY / AI_RECOMMENDATION_ANTHROPIC_ENABLED are not both set — AI Recommendation Claude probes cannot run.');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const body = buildProbeRequest(prompt, { country });
  let msg = await client.messages.create(body);
  // A long search turn can pause; hand the partial answer back so Claude finishes it (a few times, never forever).
  for (let i = 0; i < 3 && msg.stop_reason === 'pause_turn'; i += 1) {
    msg = await client.messages.create({ ...body, messages: [...body.messages, { role: 'assistant', content: msg.content }] });
  }
  const { raw, citedUrls } = answerFromMessage(msg);
  return { raw, model: MODEL, ...(body.tools ? { citedDomains: domainsFromUrls(citedUrls) } : {}) };
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
