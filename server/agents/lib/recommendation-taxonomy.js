// Static, additive-only classification for Action Center's SEO/GEO/Analytics
// source filter (see web/src/pages/ActionCenter.jsx) — consulted only to
// LABEL an already-existing recommendation for display/filtering; it never
// changes which recommendations exist, how a draft is generated, or any
// other Action Center logic. Keyed "source:generatorId" first since the
// SAME generatorId can mean a different thing depending on which agent
// recommended it (e.g. schema/faq/expand-content read as GEO when
// ai-visibility/geo-audit recommend them for AI-citation readiness, but
// content-gap's meta-title recommendation reads as classic SEO) — falls
// back to a source-level wildcard, then a generatorId-only default, then a
// catch-all so nothing currently visible in Action Center disappears just
// because it wasn't named in the product's illustrative category lists.

const BY_SOURCE_AND_GENERATOR = {
  'ai-visibility:schema': { bucket: 'geo', category: 'Citation Opportunities' },
  'ai-visibility:faq': { bucket: 'geo', category: 'FAQ Opportunities' },
  'ai-visibility:expand-content': { bucket: 'geo', category: 'Topic Coverage' },
  'geo-audit:schema': { bucket: 'geo', category: 'Citation Opportunities' },
  'geo-audit:faq': { bucket: 'geo', category: 'FAQ Opportunities' },
  'geo-audit:expand-content': { bucket: 'geo', category: 'Topic Coverage' },
  'content-gap:blog-outline': { bucket: 'geo', category: 'Entity Pages' },
  'content-gap:faq': { bucket: 'geo', category: 'FAQ Opportunities' },
  'content-gap:schema': { bucket: 'geo', category: 'Citation Opportunities' },
  'content-gap:meta-title': { bucket: 'seo', category: 'Meta Titles' },
  'ai-recommendation:blog-outline': { bucket: 'geo', category: 'AI Mentions' },
  'growth-queries:direct-answer': { bucket: 'geo', category: 'Blog Opportunities' },
  'technical-seo:meta-title': { bucket: 'seo', category: 'Meta Titles' },
  'technical-seo:broken-link-fix': { bucket: 'seo', category: 'Broken Links' },
  'technical-seo:redirect-fix': { bucket: 'seo', category: 'Broken Links' },
  'country-intelligence:landing-page': { bucket: 'seo', category: 'Landing Pages' },
  'country-intelligence:translation': { bucket: 'seo', category: 'Landing Pages' },
  // Source-level wildcards ("source:*") — bucket applies regardless of which
  // generator that source happens to recommend, for agents whose whole
  // framing is one of the three source lenses rather than any one action type.
  'opportunity:*': { bucket: 'analytics', category: 'CTR Opportunities' },
  'query-intelligence:*': { bucket: 'analytics', category: 'Traffic Anomalies' },
  'device-intelligence:*': { bucket: 'analytics', category: 'CTR Opportunities' },
  'country-intelligence:*': { bucket: 'analytics', category: 'Growth Opportunities' },
};

const BY_GENERATOR = {
  'meta-title': { bucket: 'seo', category: 'Meta Titles' },
  'expand-content': { bucket: 'seo', category: 'Content Expansion' },
  'landing-page': { bucket: 'seo', category: 'Landing Pages' },
  'broken-link-fix': { bucket: 'seo', category: 'Broken Links' },
  'redirect-fix': { bucket: 'seo', category: 'Broken Links' },
  faq: { bucket: 'geo', category: 'FAQ Opportunities' },
  'blog-outline': { bucket: 'geo', category: 'Blog Opportunities' },
  'direct-answer': { bucket: 'geo', category: 'Blog Opportunities' },
  schema: { bucket: 'geo', category: 'Citation Opportunities' },
};

// Everything else not explicitly named in the product's SEO/GEO/Analytics
// category lists (canonical, open-graph, viewport, html-lang, robots-fix,
// security-headers, internal-links, sitemap, llms-txt, translation, and any
// future generator) — a pragmatic SEO catch-all so nothing currently
// visible in Action Center disappears just because it wasn't named there.
const DEFAULT = { bucket: 'seo', category: 'Technical Fixes' };

export function classify({ source, generatorId }) {
  return BY_SOURCE_AND_GENERATOR[`${source}:${generatorId}`]
    || BY_SOURCE_AND_GENERATOR[`${source}:*`]
    || BY_GENERATOR[generatorId]
    || DEFAULT;
}
