// Self-model surfacing: command-center.js's aiRecommendationMeta.providers
// already lists every known AI provider with an honest configured/
// not-connected status (server/agents/ai-recommendation.js's meta.dataSources
// is built from the same list) — but until now it was only ever consulted
// for the pre-first-run empty state (AiRecommendationCard.jsx's
// emptyMessage). Once the agent HAS run, a site with only 1 of 3 providers
// configured showed a score with no caveat at all, silently implying full
// coverage. This is the one small, pure piece of that: given the provider
// list, decide whether the already-computed score needs a visible caveat.
export function providerCoverageCaveat(providers) {
  if (!Array.isArray(providers) || providers.length === 0) return null;
  const configuredCount = providers.filter((p) => p.configured).length;
  if (configuredCount === providers.length) return null;
  return {
    configuredCount,
    totalCount: providers.length,
    text: `Based on ${configuredCount} of ${providers.length} AI provider${providers.length === 1 ? '' : 's'} — score will reflect more coverage as others are connected.`,
  };
}
