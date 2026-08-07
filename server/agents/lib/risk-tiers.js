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
// analytics-install deliberately stays out of the safe set: its draft is
// blocked on a real tracking ID a human has to supply (see
// generators/analytics-install.js), so it can never be a genuine zero-review
// auto-publish candidate the way the rest of this list is.
//
// Re-confirmed with the user 2026-08-07: blog-outline moved back to manual.
// It no longer drafts an outline — generators/blog-outline.js now produces a
// complete, publication-ready article — so the original "it's just an
// outline for review" justification for the safe tier no longer holds. A
// full net-new blog post reaching a live PR gets one human glance first,
// same as landing-page/legal content, even though the completeness gate
// (content-scaffolding-guard.js + the word-count floor in the generator
// itself) should already keep stubs from ever reaching a draft.
const SAFE_GENERATOR_IDS = new Set([
  'meta-title', 'faq', 'schema', 'llms-txt', 'internal-links', 'sitemap',
  'robots-fix', 'security-headers', 'html-lang', 'canonical', 'viewport',
  'open-graph', 'expand-content', 'qa-content',
  // Deterministic from the page's real URL path, no LLM — same shape as
  // canonical.js, which is already in this set for the same reason.
  'breadcrumbs',
  // Safe to auto-attempt because the actual file patch (implementers/lib/
  // schema-repair-inject.js) only ever applies when the exact broken/
  // duplicate JSON-LD text is still found byte-for-byte in the site's real
  // source — a failed match already means auto-remediation.js leaves the
  // recommendation open for a human, same "exact-match auto-patch, else
  // fall back to manual" rule confirmed for alt-text below.
  'schema-repair',
]);

export function riskTierForGenerator(generatorId) {
  return SAFE_GENERATOR_IDS.has(generatorId) ? 'safe' : 'manual';
}
