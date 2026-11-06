import { dataforseoCall } from '../../../providers/dataforseo/client.js';

// REAL AI-answer tracking, as opposed to asking a model what it remembers.
//
// Every other provider in this folder calls a model API directly, which answers "what would this model say if asked
// cold". That is a weak proxy for the thing a client actually cares about: when a real person asks ChatGPT or Gemini,
// or when Google renders an AI Overview, is this company in the answer and which pages are cited. A model API cannot
// tell us that — it has no access to the assistant product's own retrieval, and its memory of a small or local market
// is thin. Confirmed on a real site: memory-only probes reported 0 mentions out of 30 prompts while the ChatGPT app
// ranked that company #2 for a comparable question (see ./openai.js's own note).
//
// DataForSEO's AI Optimization endpoints scrape the assistant products themselves, so an answer here is the answer a
// buyer would have seen, with its real cited sources. Same account and credentials as every other DataForSEO adapter
// in this codebase — no new vendor — and every call goes through the budgeted client (migration 231), so it is
// recorded per site_id and refused when a project is over its monthly cap.
//
// Engines are separate providers in DataForSEO's API but one provider here: the agent stores `model` per run, so one
// probe can legitimately return several engines' answers for the same prompt. `ask` therefore returns the engine it
// used, and `askAll` is available for callers that want every engine in one pass.
//
// Docs: /v3/ai_optimization/{chat_gpt,gemini}/llm_scraper/live/advanced
//       /v3/serp/google/organic/live/advanced  (AI Overview appears as an item in the organic SERP)

export const id = 'dataforseo-ai';

const ENGINES = Object.freeze({
  chatgpt: { endpoint: '/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced', model: 'chatgpt' },
  gemini: { endpoint: '/v3/ai_optimization/gemini/llm_scraper/live/advanced', model: 'gemini' },
  google_ai_overview: { endpoint: '/v3/serp/google/organic/live/advanced', model: 'google-ai-overview' },
});

export const ENGINE_IDS = Object.freeze(Object.keys(ENGINES));

const FETCH_TIMEOUT_MS = 60000; // a scraped assistant answer is the slowest call this codebase makes

// Its own gate, separate from the DataForSEO credentials, for the same reason openai.js keeps one: those credentials
// already exist in this deployment for keyword and backlink work, so reusing them here would silently start paid
// citation probes for every tenant with no explicit decision. Both must be true.
export function configured() {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD)
    && process.env.AI_CITATION_TRACKING_ENABLED === 'true';
}

export function enabledEngines(env = process.env) {
  const raw = String(env.AI_CITATION_ENGINES || 'chatgpt,google_ai_overview')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const kept = raw.filter((e) => ENGINE_IDS.includes(e));
  // An unrecognised list must not silently mean "all engines" — that would multiply a tenant's spend. Fall back to the
  // single cheapest, most universally useful engine instead.
  return kept.length ? kept : ['google_ai_overview'];
}

/**
 * Ask one engine one prompt, as a real person would.
 *
 * Returns { raw, model, engine, citedDomains, costUsd } — `raw` is the answer text with its real cited URLs appended,
 * so the agent's own deterministic mention check sees a citation of the company's domain even when its name is absent
 * from the prose (same convention as openai.js's textFromResponse).
 *
 * `siteId` is required: this is a paid call and every paid call belongs to a project.
 */
export async function ask(prompt, { siteId, engine = null, locationCode = null, languageCode = 'en', deps = {} } = {}) {
  if (!configured()) throw new Error('AI_CITATION_TRACKING_ENABLED is not true, or DataForSEO credentials are missing — real AI citation probes cannot run.');
  if (!siteId) throw new Error('dataforseo-ai.ask requires a siteId: every paid call belongs to a project.');
  const chosen = engine || enabledEngines()[0];
  const spec = ENGINES[chosen];
  if (!spec) throw new Error(`Unknown AI engine "${chosen}" — known: ${ENGINE_IDS.join(', ')}`);

  const call = deps.dataforseoCall || dataforseoCall;
  const out = await call({
    siteId,
    job: 'ai-citation-tracking',
    endpoint: spec.endpoint,
    body: [bodyFor(chosen, prompt, { locationCode, languageCode })],
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  if (!out.ok) {
    throw new Error(out.reason === 'budget_refused'
      ? `AI citation probe skipped: site ${siteId} has used its monthly provider budget (${out.spentUsd?.toFixed(4)} of ${out.budgetUsd} USD).`
      : `AI citation probe failed on ${chosen}: ${out.error}`);
  }

  const items = out.body?.tasks?.[0]?.result?.[0]?.items || [];
  const parsed = chosen === 'google_ai_overview' ? parseAiOverview(items) : parseLlmAnswer(items);
  if (!parsed.text && !parsed.citedDomains.length) {
    // A genuine, meaningful answer: the engine produced nothing for this prompt. Reported as an empty answer rather
    // than an error, because "no AI answer was shown" is itself the measurement.
    return { raw: '', model: spec.model, engine: chosen, citedDomains: [], costUsd: out.costUsd, empty: true };
  }

  const raw = parsed.citedDomains.length
    ? `${parsed.text}\n\nSources:\n${parsed.citedUrls.join('\n')}`
    : parsed.text;
  return { raw, model: spec.model, engine: chosen, citedDomains: parsed.citedDomains, costUsd: out.costUsd };
}

/** Every enabled engine for one prompt. A failing engine is reported, never allowed to hide the others' answers. */
export async function askAll(prompt, options = {}) {
  const results = [];
  for (const engine of enabledEngines()) {
    try {
      results.push({ engine, ...(await ask(prompt, { ...options, engine })) });
    } catch (err) {
      results.push({ engine, error: err.message });
      // A budget refusal applies to every remaining engine too, so stop rather than retry it per engine.
      if (/monthly provider budget/.test(err.message)) break;
    }
  }
  return results;
}

/**
 * Deterministic extraction — no second LLM call, unlike the model-API providers.
 *
 * Those providers must ask a model to read its own answer because they only have prose. Here the cited URLs are real
 * structured data, so whether this company was cited is a fact we can check rather than infer. Only `sentiment` and
 * `recommendationStrength` are left null: judging tone is exactly the kind of inference this codebase does not invent.
 */
export async function extract(rawResponse, { companyName, domain, competitorDomains = [] } = {}) {
  const text = String(rawResponse || '');
  const lower = text.toLowerCase();
  const cited = citedDomainsFrom(text);

  const own = normalizeDomain(domain);
  const citedByDomain = own ? cited.some((d) => d === own || d.endsWith(`.${own}`)) : false;
  const namedInProse = companyName ? lower.includes(String(companyName).trim().toLowerCase()) : false;

  const competitorsMentioned = [...new Set(
    (competitorDomains || [])
      .map(normalizeDomain)
      .filter((c) => c && c !== own && cited.some((d) => d === c || d.endsWith(`.${c}`)))
  )];

  return {
    mentioned: citedByDomain || namedInProse,
    // Where the company's own citation falls among all cited sources — the closest thing to a position an AI answer
    // has. Null when it is not cited at all, rather than a sentinel number that would read as a real rank.
    approximatePosition: citedByDomain ? cited.findIndex((d) => d === own || d.endsWith(`.${own}`)) + 1 : null,
    competitorsMentioned,
    citedDomains: cited,
    sentiment: null,
    recommendationStrength: null,
  };
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

function bodyFor(engine, prompt, { locationCode, languageCode }) {
  if (engine === 'google_ai_overview') {
    return {
      keyword: String(prompt).slice(0, 700),
      ...(locationCode ? { location_code: locationCode } : {}),
      language_code: languageCode,
      // The overview is loaded asynchronously by Google; without this the SERP comes back without it.
      load_async_ai_overview: true,
      depth: 10,
    };
  }
  return {
    user_prompt: String(prompt).slice(0, 2000),
    // Ask the assistant with live web access, which is how a real person's session behaves. Without it the answer is
    // the model's memory, which is the weak signal this adapter exists to replace.
    web_search: true,
    ...(locationCode ? { location_code: locationCode } : {}),
    language_code: languageCode,
  };
}

// The AI Overview arrives as one item among the organic SERP items, with its own references list.
function parseAiOverview(items) {
  const overview = items.find((i) => i?.type === 'ai_overview');
  if (!overview) return { text: '', citedUrls: [], citedDomains: [] };
  const parts = [];
  const urls = [];
  for (const element of overview.items || []) {
    if (element?.text) parts.push(element.text);
    for (const ref of element?.references || []) if (ref?.url) urls.push(ref.url);
  }
  for (const ref of overview.references || []) if (ref?.url) urls.push(ref.url);
  return finish(parts.join('\n'), urls);
}

// A scraped assistant answer arrives as message items, each with optional annotations carrying the sources it used.
function parseLlmAnswer(items) {
  const parts = [];
  const urls = [];
  for (const item of items) {
    if (item?.text) parts.push(item.text);
    if (item?.message) parts.push(item.message);
    for (const section of item?.sections || []) {
      if (section?.text) parts.push(section.text);
      for (const link of section?.links || []) if (link?.url) urls.push(link.url);
      for (const ref of section?.annotations || []) if (ref?.url) urls.push(ref.url);
    }
    for (const ref of item?.annotations || []) if (ref?.url) urls.push(ref.url);
  }
  return finish(parts.join('\n'), urls);
}

function finish(text, urls) {
  const citedUrls = [...new Set(urls.filter(Boolean))];
  return {
    text: String(text || '').trim(),
    citedUrls,
    citedDomains: [...new Set(citedUrls.map(domainOf).filter(Boolean))],
  };
}

export function citedDomainsFrom(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s)<>"']+/g) || [];
  return [...new Set(urls.map(domainOf).filter(Boolean))];
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function normalizeDomain(raw) {
  if (!raw) return null;
  const d = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^sc-domain:/, '').replace(/^www\./, '').split('/')[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}
