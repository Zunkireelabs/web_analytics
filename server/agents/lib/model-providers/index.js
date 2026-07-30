import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import * as perplexity from './perplexity.js';

// Ordered, stable list of every AI-recommendation probe provider this
// codebase knows how to speak to. Order matters only for display (facts.providers
// preserves this order) — never for correctness, since each provider's own
// `configured()` independently gates whether it runs at all.
export const PROVIDERS = [openai, anthropic, perplexity];

// The one seam server/agents/ai-recommendation.js needs: which providers
// are ACTUALLY usable right now, given real env vars. A deployment with
// only OPENAI_API_KEY + AI_RECOMMENDATION_ENABLED=true set gets exactly
// [openai] back — identical to this agent's pre-multi-provider behavior.
export function getConfiguredProviders() {
  return PROVIDERS.filter((p) => p.configured());
}
