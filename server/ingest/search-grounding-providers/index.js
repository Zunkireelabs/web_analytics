import * as googleCse from '../competitor-providers/google-cse.js';

// Capability-based provider registry for "real, verified source URLs to
// ground an LLM citation in" — the same configured()-gate pattern
// competitor-providers/index.js already uses for SERP ranking, applied to a
// different capability so citation search stops being hard-coded to one
// specific provider (google-cse) directly. Before this existed,
// generators/expand-content.js imported google-cse.js by name and failed
// closed whenever THAT ONE provider wasn't configured, even if another
// grounding-capable provider existed. Now it asks this registry instead, so
// adding a second provider that implements searchSources() is a one-line
// addition here — no change to expand-content.js.
//
// Only google-cse is registered today: DataForSEO's real product is SERP
// ranking, not general web search — it has no searchSources()-equivalent
// capability to register, so this list has one entry until a provider that
// actually offers real search grounding is added. Not registering a
// provider that can't do the job is the honest state here, not a gap.
const PROVIDERS = [googleCse];

// First registered provider whose configured() is true, tried in list
// order — the same fail-safe pattern PROVIDERS.find() already reads as
// "try these in priority order, use the first one that's actually ready."
export function getConfiguredGroundingProvider() {
  return PROVIDERS.find((p) => p.configured()) || null;
}

export function groundingProviderConfigured() {
  return !!getConfiguredGroundingProvider();
}

// Callers must treat groundingProviderConfigured() as the gate for whether
// to call this at all, same discipline as google-cse.js's own searchSources.
export async function searchGroundedSources(query, num = 3) {
  const provider = getConfiguredGroundingProvider();
  if (!provider) throw new Error('No search-grounding provider is configured.');
  return provider.searchSources(query, num);
}
