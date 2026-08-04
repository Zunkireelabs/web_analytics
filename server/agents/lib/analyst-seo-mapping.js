import { knownDomain } from './site-domain.js';

// Maps an Analyst (data-analyst-agent) insight onto the existing Action
// Center draft-generation pipeline — a completely separate system keyed by
// Node-side "findings" (see recommendations.js), which an Analyst insight
// is not. Deliberately narrow: only a gsc_* metric with dimension_type
// 'page' (never true today — anomaly/trend-shift detection only runs on
// site/device/country/channel — until data-analyst-agent's
// gsc_page_dimension collector admits a page, see that collector's
// docstring) representing a real decline is eligible for 'expand-content'
// (thin/declining content is the one generator a metric anomaly can point
// at without guessing a schema type or topic). Returns null for anything
// else — callers must treat null as "not eligible," never throw.
function isDecline(insight) {
  const e = insight?.evidence || {};
  switch (insight?.insight_type) {
    case 'trend_shift': return typeof e.pct_change === 'number' && e.pct_change < 0;
    case 'anomaly': return e.direction === 'low';
    case 'forecast_risk': return true; // a forecast_risk insight is a decline by definition
    case 'milestone': return e.direction === 'down';
    default: return false;
  }
}

// GSC's page dimension is documented to return full absolute URLs, but
// this falls back to prefixing the site's own known domain defensively
// rather than assuming that's always true.
function absolutePageUrl(site, dimensionValue) {
  if (/^https?:\/\//i.test(dimensionValue)) return dimensionValue;
  const domain = knownDomain(site);
  if (!domain) return null;
  return `https://${domain}${dimensionValue.startsWith('/') ? '' : '/'}${dimensionValue}`;
}

export function seoDraftEligibility(site, insight) {
  if (!insight?.metric_key?.startsWith('gsc_')) return null;
  if (insight.dimension_type !== 'page' || !insight.dimension_value) return null;
  if (!isDecline(insight)) return null;

  const page = absolutePageUrl(site, insight.dimension_value);
  if (!page) return null;

  return {
    generatorId: 'expand-content',
    params: { page },
    // Deterministic per (metric, type, period, page) — getDraftByFindingId's
    // idempotency check relies on this being stable across repeated calls
    // for the same finding, not random per request.
    findingId: `analyst:${insight.metric_key}:${insight.insight_type}:${insight.period_start}:${insight.dimension_value}`,
  };
}
