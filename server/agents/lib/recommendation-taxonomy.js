// Static, additive-only classification for Action Center's SEO/AEO/GEO
// source filter (see web/src/pages/ActionCenter.jsx) — consulted only to
// LABEL an already-existing recommendation for display/filtering; it never
// changes which recommendations exist, how a draft is generated, or any
// other Action Center logic. Keyed "source:generatorId" first since the
// SAME generatorId can mean a different thing depending on which agent
// recommended it (e.g. schema/faq/expand-content read as AEO when
// ai-visibility/content-gap recommend them for AI-citation readiness, but
// geo-signals' own expand-content reads as GEO, and content-gap's meta-title
// reads as classic SEO) — falls back to a source-level wildcard, then a
// generatorId-only default, then a catch-all so nothing currently visible
// in Action Center disappears just because it wasn't named in the
// product's illustrative category lists.
//
// Bucket meanings (match GrowthScores.jsx's four real score tiles):
// - seo: classic technical/on-site fixes, also the fold-in home for the
//   traffic-pattern findings (opportunity/query/device/country-intelligence)
//   that used to have their own "Analytics" tab.
// - aeo: AI-citation/answer-engine readiness — the same pillar the
//   ai-visibility agent's real siteScore.overall (the AEO score tile) is
//   computed from.
// - geo: Generative Engine signals — the same pillar the geo-signals agent
//   feeds into the weekly geo-audit report's real score (the GEO score
//   tile). NOT the same source id as the "geo-audit" generator/report —
//   the agent that actually produces these findings is `geo-signals`.

const BY_SOURCE_AND_GENERATOR = {
  'ai-visibility:schema': { bucket: 'aeo', category: 'Citation Opportunities' },
  'ai-visibility:faq': { bucket: 'aeo', category: 'FAQ Opportunities' },
  'ai-visibility:expand-content': { bucket: 'aeo', category: 'Topic Coverage' },
  'geo-signals:schema': { bucket: 'geo', category: 'Citation Opportunities' },
  'geo-signals:expand-content': { bucket: 'geo', category: 'GEO Signals' },
  'geo-signals:llms-txt': { bucket: 'geo', category: 'AI Crawler Access' },
  'content-gap:blog-outline': { bucket: 'aeo', category: 'Entity Pages' },
  'content-gap:faq': { bucket: 'aeo', category: 'FAQ Opportunities' },
  'content-gap:schema': { bucket: 'aeo', category: 'Citation Opportunities' },
  'content-gap:meta-title': { bucket: 'seo', category: 'Meta Titles' },
  'ai-recommendation:blog-outline': { bucket: 'aeo', category: 'AI Mentions' },
  'growth-queries:direct-answer': { bucket: 'geo', category: 'Blog Opportunities' },
  'technical-seo:meta-title': { bucket: 'seo', category: 'Meta Titles' },
  'technical-seo:broken-link-fix': { bucket: 'seo', category: 'Broken Links' },
  'technical-seo:redirect-fix': { bucket: 'seo', category: 'Broken Links' },
  'country-intelligence:landing-page': { bucket: 'seo', category: 'Landing Pages' },
  'country-intelligence:translation': { bucket: 'seo', category: 'Landing Pages' },
  // Source-level wildcards ("source:*") — bucket applies regardless of which
  // generator that source happens to recommend, for agents whose whole
  // framing is one of the three source lenses rather than any one action
  // type. Folded into "seo" (previously their own "Analytics" tab).
  'opportunity:*': { bucket: 'seo', category: 'CTR Opportunities' },
  'query-intelligence:*': { bucket: 'seo', category: 'Traffic Anomalies' },
  'device-intelligence:*': { bucket: 'seo', category: 'CTR Opportunities' },
  'country-intelligence:*': { bucket: 'seo', category: 'Growth Opportunities' },
};

const BY_GENERATOR = {
  'meta-title': { bucket: 'seo', category: 'Meta Titles' },
  'expand-content': { bucket: 'seo', category: 'Content Expansion' },
  'landing-page': { bucket: 'seo', category: 'Landing Pages' },
  'broken-link-fix': { bucket: 'seo', category: 'Broken Links' },
  'redirect-fix': { bucket: 'seo', category: 'Broken Links' },
  faq: { bucket: 'aeo', category: 'FAQ Opportunities' },
  'blog-outline': { bucket: 'aeo', category: 'Blog Opportunities' },
  'direct-answer': { bucket: 'geo', category: 'Blog Opportunities' },
  schema: { bucket: 'aeo', category: 'Citation Opportunities' },
};

// Everything else not explicitly named in the product's SEO/AEO/GEO
// category lists (canonical, open-graph, viewport, html-lang, robots-fix,
// security-headers, internal-links, sitemap, translation, cookie-policy,
// privacy-policy, and any future generator) — a pragmatic SEO catch-all so
// nothing currently visible in Action Center disappears just because it
// wasn't named there.
const DEFAULT = { bucket: 'seo', category: 'Technical Fixes' };

export function classify({ source, generatorId }) {
  return BY_SOURCE_AND_GENERATOR[`${source}:${generatorId}`]
    || BY_SOURCE_AND_GENERATOR[`${source}:*`]
    || BY_GENERATOR[generatorId]
    || DEFAULT;
}
