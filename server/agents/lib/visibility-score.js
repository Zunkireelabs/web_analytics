// AI Visibility scoring — seven 0-100 category scores plus an unweighted
// overall average, computed only from real, deterministic page/site signals
// (never a fabricated or estimated value). Each category is graduated by
// tiers of real evidence rather than a flat pass/fail, so the score reflects
// "how much" readiness signal exists, not just whether any exists at all.

const ENTITY_SCHEMA_TYPES = ['Organization', 'Person', 'Product', 'LocalBusiness'];

function schemaScore(analysis) {
  return Math.min(100, analysis.schemaTypes.length * 25);
}

function structuredContentScore(analysis) {
  let score = 0;
  if (analysis.h1Count === 1) score += 34;
  if (analysis.h2Count > 0) score += 33;
  if (analysis.listCount > 0 || analysis.tableCount > 0) score += 33;
  return score;
}

function faqScore(analysis) {
  if (analysis.hasFaqSchema) return 100; // FAQPage schema — strongest, machine-readable
  if (analysis.hasFaqHeading) return 60; // heading-only FAQ — visible to readers, not structured for machines
  return 0;
}

function entitiesScore(analysis) {
  const found = analysis.schemaTypes.filter((t) => ENTITY_SCHEMA_TYPES.includes(t)).length;
  if (found >= 2) return 100;
  if (found === 1) return 70;
  return 0;
}

function citationReadinessScore(analysis) {
  if (analysis.questionHeadingCount >= 3) return 100;
  if (analysis.questionHeadingCount >= 1) return 60;
  return 0;
}

function llmsReadinessScore({ hasLlmsTxt, hasValidLlmsTxtStructure, hasRobotsTxt, robotsAllowsAiCrawlers }) {
  let score = 0;
  // Full credit only for a file that both exists and follows the llms.txt
  // convention (# Title + markdown links) — a malformed file still gets
  // partial credit since it's better than nothing, but shouldn't score the
  // same as a correctly structured one.
  if (hasLlmsTxt) score += hasValidLlmsTxtStructure ? 50 : 25;
  // No robots.txt at all is treated as "not blocking" (default-allow), same
  // as robotsAllowsAiCrawlers === true — only an explicit disallow costs points.
  if (!hasRobotsTxt || robotsAllowsAiCrawlers !== false) score += 50;
  return score;
}

// Per-page category scores (excludes llmsReadiness, which is site-level —
// callers combine it in separately, same value for every page in a run).
export function scorePageCategories(analysis) {
  return {
    schema: schemaScore(analysis),
    structuredContent: structuredContentScore(analysis),
    faq: faqScore(analysis),
    entities: entitiesScore(analysis),
    citationReadiness: citationReadinessScore(analysis),
  };
}

export function scoreLlmsReadiness(llmsReadiness) {
  return llmsReadinessScore(llmsReadiness);
}

export function geoSignalsScore(analysis) {
  let score = 0;
  if (analysis.hasAuthorSignal) score += 33;
  if (analysis.hasComparisonContent) score += 33;
  if (analysis.hasFreshnessSignal) score += 34;
  return Math.min(100, score);
}

// Combines a page's five on-page category scores (schema, structuredContent,
// faq, entities, citationReadiness) and its own geoSignals score with the
// run's one site-level LLMS readiness score into the full seven-category
// breakdown plus an unweighted overall average.
export function combineScores(pageCategories, llmsScore, geoSignalsScore) {
  const categories = { ...pageCategories, llmsReadiness: llmsScore, geoSignals: geoSignalsScore };
  const values = Object.values(categories);
  const overall = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
  return { overall, categories };
}
