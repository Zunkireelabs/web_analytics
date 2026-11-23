import { ctrAtPosition, TARGET_POSITION, TRAFFIC_GAIN_NOTE } from './opportunity-scoring.js';
import { isBrandedQuery } from './branded-query.js';

// Per-site CTR-by-position curve, measured from the site's own Search Console
// rows and used in place of opportunity-scoring.js's fixed industry curve
// wherever a "this query/page is under-clicked for its rank" judgement or a
// traffic-gain projection is made (growth-opportunities quick wins,
// growth-scoring's ctr-gap demand bonus, the Opportunity agent).
//
// Why per-site: CTR at a given position varies a lot by niche and SERP layout
// (ads, AI Overviews, local packs, sitelinks). Against a generic curve, a site
// whose whole SERP landscape is lower-CTR has every page flagged as
// "underperforming", and a high-CTR niche has none flagged. Comparing a page to
// what THIS site normally earns at that rank flags the genuine outliers.
//
// How thin data is handled — shrinkage, not a hard threshold: each position
// bucket's CTR is
//     (siteClicks + PRIOR_IMPRESSIONS * industryCtr) / (siteImpressions + PRIOR_IMPRESSIONS)
// i.e. the industry curve acts as PRIOR_IMPRESSIONS worth of pseudo-data. A
// bucket with no site data is exactly the industry value; a bucket with lots
// of site data is essentially the site's own measured CTR; in between it moves
// smoothly. Nothing ever jumps because one bucket crossed an arbitrary count.
//
// Branded queries are excluded: a brand search at #1 routinely earns 40-60%+
// CTR, which would inflate the site's position-1/2 baseline and make every
// non-brand top-3 query look under-clicked. Uses the same isBrandedQuery the
// cannibalization check uses (the site's own real `name`, never a guessed list).
//
// Monotonic: real CTR falls with position, but small samples can invert two
// neighbouring buckets. Each bucket is capped at the one above it so a page at
// #4 is never expected to out-click #3.

export const PRIOR_IMPRESSIONS = 500;
// A bucket whose own impressions are at least this many is reported as
// 'site' (site data carries >= 80% of the weight at PRIOR_IMPRESSIONS=500).
export const SITE_DOMINANT_IMPRESSIONS = 2000;
const MAX_POSITION_BUCKET = 10;
// Rows ranking deeper than this are ignored for the tail bucket — page 3+
// impressions are rare, noisy, and not what any caller scores.
const TAIL_MAX_POSITION = 20;
const TAIL = 'tail';

function bucketSource(impressions) {
  if (impressions >= SITE_DOMINANT_IMPRESSIONS) return 'site';
  if (impressions > 0) return 'blended';
  return 'industry';
}

function keyFor(position) {
  const rounded = Math.max(1, Math.round(position));
  if (rounded <= MAX_POSITION_BUCKET) return rounded;
  return position <= TAIL_MAX_POSITION ? TAIL : null;
}

/**
 * Pure.
 * @param rows   [{ query, avgPosition, clicks, impressions }] — one per query
 *               (or per query+page); getQueryPageMetrics' shape.
 * @param opts   { siteName } — the site's real name, for branded exclusion.
 * @returns curve { at(position), sourceAt(position), source, summary }
 */
export function buildSiteCtrCurve(rows = [], { siteName = null } = {}) {
  const acc = new Map();
  let brandedExcluded = 0;
  for (const r of rows) {
    const impressions = Number(r.impressions) || 0;
    const position = r.avgPosition == null ? null : Number(r.avgPosition);
    if (impressions <= 0 || position == null || !Number.isFinite(position)) continue;
    if (isBrandedQuery(r.query || '', siteName)) { brandedExcluded += 1; continue; }
    const key = keyFor(position);
    if (key == null) continue;
    const a = acc.get(key) || { clicks: 0, impressions: 0, rows: 0 };
    a.clicks += Number(r.clicks) || 0;
    a.impressions += impressions;
    a.rows += 1;
    acc.set(key, a);
  }

  const keys = [...Array.from({ length: MAX_POSITION_BUCKET }, (_, i) => i + 1), TAIL];
  const buckets = new Map();
  let ceiling = 1;
  for (const key of keys) {
    const industryCtr = ctrAtPosition(key === TAIL ? MAX_POSITION_BUCKET + 1 : key);
    const a = acc.get(key) || { clicks: 0, impressions: 0, rows: 0 };
    const blended = (a.clicks + PRIOR_IMPRESSIONS * industryCtr) / (a.impressions + PRIOR_IMPRESSIONS);
    const ctr = Math.min(blended, ceiling);
    ceiling = ctr;
    buckets.set(key, {
      position: key, ctr, industryCtr,
      measuredCtr: a.impressions > 0 ? a.clicks / a.impressions : null,
      impressions: a.impressions, rows: a.rows,
      source: bucketSource(a.impressions),
    });
  }

  const bucketFor = (position) => buckets.get(keyFor(Number(position)) ?? TAIL);
  const sources = keys.slice(0, MAX_POSITION_BUCKET).map((k) => buckets.get(k).source);
  const source = sources.every((s) => s === 'industry') ? 'industry'
    : sources.every((s) => s === 'site') ? 'site' : 'blended';

  return {
    at: (position) => bucketFor(position).ctr,
    sourceAt: (position) => bucketFor(position).source,
    source,
    summary: {
      source,
      priorImpressions: PRIOR_IMPRESSIONS,
      brandedExcluded,
      buckets: keys.map((k) => {
        const b = buckets.get(k);
        return {
          position: b.position, ctr: Number(b.ctr.toFixed(4)), industryCtr: b.industryCtr,
          measuredCtr: b.measuredCtr == null ? null : Number(b.measuredCtr.toFixed(4)),
          impressions: b.impressions, source: b.source,
        };
      }),
    },
  };
}

// The fixed industry curve wrapped in the same interface, for callers with no
// site rows (or a failed fetch): behaviour identical to before this module.
export const INDUSTRY_CTR_CURVE = Object.freeze({
  at: ctrAtPosition,
  sourceAt: () => 'industry',
  source: 'industry',
  summary: { source: 'industry', priorImpressions: PRIOR_IMPRESSIONS, brandedExcluded: 0, buckets: [] },
});

// Short label for user-facing text, so a number is never presented as more
// site-specific than it is.
export function curveLabel(source) {
  if (source === 'site') return "this site's own CTR at that position";
  if (source === 'blended') return "this site's CTR at that position (blended with an industry average where data is thin)";
  return 'an industry-average CTR for that position (not measured for this site)';
}

// Replacement for opportunity-scoring.js's TRAFFIC_GAIN_NOTE that states which
// curve the estimate actually used. Unchanged text for the industry curve.
export function trafficGainNote(curve = INDUSTRY_CTR_CURVE) {
  if (curve.source === 'industry') return TRAFFIC_GAIN_NOTE;
  return `estimatedTrafficGain assumes the query reaches position ${TARGET_POSITION} and applies ` +
    `${curve.source === 'site' ? "this site's own measured" : "this site's measured (blended with an industry average where thin)"} ` +
    'CTR-by-position curve from its Search Console data, branded queries excluded — an estimate, not a guarantee.';
}
