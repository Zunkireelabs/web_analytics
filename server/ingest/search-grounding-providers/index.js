import * as tavily from './tavily.js';

// Capability-based provider registry for "real, verified source URLs to
// ground an LLM citation in" — used only by generators/expand-content.js's
// external-citations focus.
//
// Tavily is the sole provider here, deliberately. It replaced an earlier
// serpapi/google-cse fallback chain: those two exist for
// server/ingest/competitor-providers/ (real Google SERP ranking data — SEO/
// keyword-demand intelligence, still live there, untouched) and were only
// ever reused here because they happened to also expose a generic
// searchSources() call. Zunkiree's autonomous growth system now grounds
// citations exclusively through Tavily — a provider actually built for
// LLM-facing search/grounding — so this registry never falls back to
// google-cse or serpapi for this path, even if one of them is configured
// for competitor intelligence. Do not re-add them here.
//
// DataForSEO's real product is SERP ranking, not general web search — it
// has no searchSources()-equivalent capability to register, so it's absent
// here too (not a gap; not registering a provider that can't do the job is
// the honest state).
const PROVIDERS = [tavily];

export function getConfiguredGroundingProvider() {
  return PROVIDERS.find((p) => p.configured()) || null;
}

export function groundingProviderConfigured() {
  return !!getConfiguredGroundingProvider();
}

// Callers must treat groundingProviderConfigured() as the gate for whether
// to call this at all. Tavily's own errors (quota, network, timeout)
// propagate as-is — expand-content.js wraps them with safeMessage() into a
// customer-safe "citation search is temporarily unavailable" failure rather
// than crashing the whole draft.
// Pages on one topic ask near-identical queries ("best it companies in nepal"
// / "top it companies nepal"), and every uncached call spends Tavily quota. A
// result set is reused for any later query on the same topic — token-set
// similarity, not exact string — for a day. In-memory on purpose: a restart
// only costs a few repeat searches, and nothing stale can outlive the process.
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.6;
const QUERY_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'in', 'to', 'for', 'and', 'on', 'is', 'are', 'what', 'how', 'best', 'top']);
const searchCache = []; // { tokens:Set, num, results, at }

export function queryTokens(query) {
  return new Set(String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !QUERY_STOPWORDS.has(t)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
export function clearSearchCache() { searchCache.length = 0; }

export async function searchGroundedSources(query, num = 3) {
  const provider = getConfiguredGroundingProvider();
  if (!provider) throw new Error('No search-grounding provider is configured.');
  const tokens = queryTokens(query);
  const now = Date.now();
  const hit = searchCache.find((c) => now - c.at < SEARCH_CACHE_TTL_MS && c.num >= num && jaccard(tokens, c.tokens) >= SIMILARITY_THRESHOLD);
  if (hit) return hit.results.slice(0, num);
  const results = await provider.searchSources(query, num);
  if (tokens.size) searchCache.push({ tokens, num, results, at: now });
  return results;
}
