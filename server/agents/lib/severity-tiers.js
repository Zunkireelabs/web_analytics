// The growth hierarchy the daily run selects against: which KIND of work
// matters most, independent of which agent happened to file it.
//
// This exists because `recommendations.priority` cannot answer that question.
// priorityByRank (agents/lib/findings.js) assigns high/medium/low as thirds
// WITHIN one agent's own candidate list for one run — so a 'high' from
// technical-seo.js and a 'high' from accessibility.js are not the same claim,
// and sorting by that column first (as the scheduler did) ranks by "how did
// this item compare to its own siblings", never by "how much does this matter
// to the site". A 20-page indexing fault and a single cosmetic tweak can both
// be 'high'.
//
// Tiers are deliberately coarse and hand-assigned. The alternative — deriving
// severity from expected_impact.value — is not available: that column has no
// common unit across agents (summed GSC impressions in technical-seo.js and
// geo-signals.js, a count of affected items in content-integrity.js and
// accessibility.js, a delta in query-intelligence.js, a percentage in
// ai-recommendation.js), so comparing two values across generators is
// meaningless. See growth-scoring.js, which uses only the comparable
// expected_impact.label as a tiebreaker.
export const SEVERITY_TIER = {
  // 1 — CRITICAL TECHNICAL / INDEXING. A page search engines cannot reach,
  // parse, or attribute correctly earns nothing from any amount of content
  // work layered on top, so these come first regardless of the page's current
  // traffic — the traffic is often zero *because* of these.
  CRITICAL_TECHNICAL: 1,
  // 2 — HIGH-IMPACT ON-PAGE. The page is indexable; what it says to search
  // (and to a human in the SERP) is wrong, missing, or thin.
  ON_PAGE: 2,
  // 3 — SEARCH-BACKED EXPANSION. Real measured demand exists for this page —
  // impressions without clicks, or a rank just off page 1. Ranked here as a
  // floor; growth-scoring.js lifts individual items within the tier using the
  // actual GSC numbers.
  EXPANSION: 3,
  // 4 — NET-NEW CONTENT. Genuinely valuable, but speculative next to fixing a
  // page that already ranks, and rate-limited by its own pacing rules.
  CONTENT: 4,
  // 5 — CLEANUP / COSMETIC.
  CLEANUP: 5,
};

// generatorId -> tier. Every safe-tier generator in risk-tiers.js appears
// here; anything unlisted falls to DEFAULT_TIER below rather than silently
// scoring as critical.
const TIER_BY_GENERATOR = {
  // ── 1. Critical technical SEO / indexing ────────────────────────────────
  canonical: SEVERITY_TIER.CRITICAL_TECHNICAL,       // wrong canonical splits or hides a page outright
  'robots-fix': SEVERITY_TIER.CRITICAL_TECHNICAL,    // can block crawling site-wide
  sitemap: SEVERITY_TIER.CRITICAL_TECHNICAL,         // discovery of every URL on the site
  'broken-link-fix': SEVERITY_TIER.CRITICAL_TECHNICAL,
  // Same dead link, same urgency — the severity is a property of the broken
  // link, not of which of the two fixes the site's structure allows.
  'missing-page-create': SEVERITY_TIER.CRITICAL_TECHNICAL,
  'redirect-fix': SEVERITY_TIER.CRITICAL_TECHNICAL,
  'duplicate-id-fix': SEVERITY_TIER.CRITICAL_TECHNICAL, // duplicate ids break parsing/anchors
  'html-lang': SEVERITY_TIER.CRITICAL_TECHNICAL,
  viewport: SEVERITY_TIER.CRITICAL_TECHNICAL,        // mobile usability is an indexing input
  'schema-repair': SEVERITY_TIER.CRITICAL_TECHNICAL, // malformed structured data actively misleads
  'content-integrity-repair': SEVERITY_TIER.CRITICAL_TECHNICAL, // template/rendering leakage
  'security-headers': SEVERITY_TIER.CRITICAL_TECHNICAL,

  // ── 2. High-impact on-page ──────────────────────────────────────────────
  'meta-title': SEVERITY_TIER.ON_PAGE,
  schema: SEVERITY_TIER.ON_PAGE,                     // adding valid structured data (vs repairing broken)
  'open-graph': SEVERITY_TIER.ON_PAGE,
  breadcrumbs: SEVERITY_TIER.ON_PAGE,
  'internal-links': SEVERITY_TIER.ON_PAGE,
  'direct-answer': SEVERITY_TIER.ON_PAGE,
  faq: SEVERITY_TIER.ON_PAGE,
  'analytics-install': SEVERITY_TIER.ON_PAGE,        // without it, nothing downstream can be measured

  // ── 3. Search-backed expansion ──────────────────────────────────────────
  'expand-content': SEVERITY_TIER.EXPANSION,
  'qa-content': SEVERITY_TIER.EXPANSION,

  // ── 4. Net-new content ──────────────────────────────────────────────────
  'blog-outline': SEVERITY_TIER.CONTENT,

  // ── 5. Cleanup / cosmetic / secondary ───────────────────────────────────
  'alt-text': SEVERITY_TIER.CLEANUP,
  'blog-image': SEVERITY_TIER.CLEANUP,
  'llms-txt': SEVERITY_TIER.CLEANUP,
  'geo-audit': SEVERITY_TIER.CLEANUP,
  'cookie-policy': SEVERITY_TIER.CLEANUP,
  'privacy-policy': SEVERITY_TIER.CLEANUP,
  'terms-of-service': SEVERITY_TIER.CLEANUP,
};

// An unknown generator is treated as ordinary on-page work, not as critical.
// Guessing high for something unrecognized would let any new generator
// out-rank real indexing faults on its first day purely by being unlisted.
export const DEFAULT_TIER = SEVERITY_TIER.ON_PAGE;

export const TIER_LABEL = {
  [SEVERITY_TIER.CRITICAL_TECHNICAL]: 'critical-technical',
  [SEVERITY_TIER.ON_PAGE]: 'on-page',
  [SEVERITY_TIER.EXPANSION]: 'expansion',
  [SEVERITY_TIER.CONTENT]: 'content',
  [SEVERITY_TIER.CLEANUP]: 'cleanup',
};

export function severityTierFor(generatorId) {
  return TIER_BY_GENERATOR[generatorId] ?? DEFAULT_TIER;
}

export function severityTierLabel(generatorId) {
  return TIER_LABEL[severityTierFor(generatorId)];
}
