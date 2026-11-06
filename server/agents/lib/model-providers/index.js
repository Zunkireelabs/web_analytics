import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import * as perplexity from './perplexity.js';
import * as dataforseoAi from './dataforseo-ai.js';

// Ordered, stable list of every AI-recommendation probe provider this
// codebase knows how to speak to. Order matters only for display (facts.providers
// preserves this order) — never for correctness, since each provider's own
// `configured()` independently gates whether it runs at all.
// dataforseo-ai is listed FIRST deliberately: it is the only provider that observes what a real person would have
// seen (the assistant products themselves, with their real cited sources) rather than what a model recalls when asked
// cold. Order here affects display only, but putting the real measurement first is the honest default. Like every
// other provider it is gated by its own `configured()` (AI_CITATION_TRACKING_ENABLED), so adding it changes nothing
// for a deployment that has not opted in.
export const PROVIDERS = [dataforseoAi, openai, anthropic, perplexity];

// The one seam server/agents/ai-recommendation.js needs: which providers
// are ACTUALLY usable right now, given real env vars. A deployment with
// only OPENAI_API_KEY + AI_RECOMMENDATION_ENABLED=true set gets exactly
// [openai] back — identical to this agent's pre-multi-provider behavior.
export function getConfiguredProviders() {
  return PROVIDERS.filter((p) => p.configured());
}
