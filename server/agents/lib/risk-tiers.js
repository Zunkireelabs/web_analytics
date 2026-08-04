// Phase 4 §5's safe/manual split, keyed by generatorId (= recommendations.recommendation_type).
// SAFE generators are eligible for the Execution Engine's auto-chain
// (executeSafeFixes/approveAndShipRecommendation, execution-engine.js) —
// everything else always goes through the existing stepped
// Generate -> Submit -> Approve flow with a human decision at each step.
//
// Confirmed with the user 2026-08-04: broken-link-fix and blog-outline
// swapped from their first-draft classification (broken-link-fix moved to
// manual — a wrong redirect/link fix breaks live navigation; blog-outline
// moved to safe — it drafts an outline for review, doesn't publish net-new
// pages on its own). cookie-policy/privacy-policy/terms-of-service default
// to manual (not in the spec's explicit safe list, legal-content risk).
const SAFE_GENERATOR_IDS = new Set([
  'meta-title', 'faq', 'schema', 'llms-txt', 'internal-links', 'sitemap',
  'robots-fix', 'security-headers', 'html-lang', 'canonical', 'viewport',
  'open-graph', 'expand-content', 'blog-outline',
]);

export function riskTierForGenerator(generatorId) {
  return SAFE_GENERATOR_IDS.has(generatorId) ? 'safe' : 'manual';
}
