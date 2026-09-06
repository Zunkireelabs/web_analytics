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
export async function searchGroundedSources(query, num = 3) {
  const provider = getConfiguredGroundingProvider();
  if (!provider) throw new Error('No search-grounding provider is configured.');
  return provider.searchSources(query, num);
}
