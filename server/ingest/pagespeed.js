// Google PageSpeed Insights v5 API — the real source for Core Web Vitals.
// Optional: without PAGESPEED_API_KEY, the technical-seo agent still
// reports real index status, technical audit, and broken-link findings —
// CWV findings just don't appear, reported honestly as insufficient-data
// for that one sub-check rather than faked. Same convention as
// server/ingest/competitor-providers/dataforseo.js's authHeader().

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const FETCH_TIMEOUT_MS = 15000; // PSI itself runs a real Lighthouse pass server-side — genuinely slower than a plain page fetch

export function configured() {
  return !!process.env.PAGESPEED_API_KEY;
}

// Real Google-published Core Web Vitals thresholds (ms for LCP/INP, unitless for CLS).
function categoryFor(metric, value) {
  if (value == null) return null;
  const THRESHOLDS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] };
  const [good, ok] = THRESHOLDS[metric];
  if (value <= good) return 'GOOD';
  if (value <= ok) return 'NEEDS_IMPROVEMENT';
  return 'POOR';
}

// Prefers real field data (loadingExperience — actual Chrome UX Report
// traffic for this exact URL, what genuinely affects rankings) over lab
// data (lighthouseResult — a single simulated run). Low-traffic pages
// commonly have no field data; that's degraded to lab data honestly, never
// silently upgraded to look like real field measurements.
export async function fetchCoreWebVitals(pageUrl, { strategy = 'mobile' } = {}) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) throw new Error('PAGESPEED_API_KEY is not set — Core Web Vitals cannot be fetched.');

  const url = `${ENDPOINT}?url=${encodeURIComponent(pageUrl)}&key=${key}&strategy=${strategy}&category=performance`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let body;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `PageSpeed Insights request failed: HTTP ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(timeout);
  }

  const field = body?.loadingExperience?.metrics;
  if (field?.LARGEST_CONTENTFUL_PAINT_MS || field?.CUMULATIVE_LAYOUT_SHIFT_SCORE || field?.INTERACTION_TO_NEXT_PAINT) {
    const lcp = field.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null;
    const cls = field.CUMULATIVE_LAYOUT_SHIFT_SCORE ? field.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : null;
    const inp = field.INTERACTION_TO_NEXT_PAINT?.percentile ?? null;
    const category = body.loadingExperience.overall_category
      ?? ([categoryFor('lcp', lcp), categoryFor('inp', inp), categoryFor('cls', cls)].includes('POOR') ? 'POOR' : 'GOOD');
    return { ok: true, dataSource: 'field', lcp, inp, cls, category };
  }

  // No real field data for this URL — fall back to one simulated Lighthouse
  // run (lab data), explicitly labeled as such.
  const audits = body?.lighthouseResult?.audits;
  const perfScore = body?.lighthouseResult?.categories?.performance?.score;
  if (!audits) return { ok: false, error: 'no field or lab data returned' };
  const lcp = audits['largest-contentful-paint']?.numericValue ?? null;
  const cls = audits['cumulative-layout-shift']?.numericValue ?? null;
  const inp = audits['interaction-to-next-paint']?.numericValue ?? audits['total-blocking-time']?.numericValue ?? null;
  const category = perfScore == null ? null : perfScore >= 0.9 ? 'GOOD' : perfScore >= 0.5 ? 'NEEDS_IMPROVEMENT' : 'POOR';
  return { ok: true, dataSource: 'lab', lcp, inp, cls, category };
}

// Real tap-target-sizing and legible-font-size checks — the two Lighthouse
// "seo" category audits agents/mobile-usability.js's own dataSources entry
// has always documented as real but "not-connected", because
// fetchCoreWebVitals above only ever requests category=performance. Same
// endpoint, same key, a second request with category=seo — PSI does not let
// one call return multiple categories' full audit detail together.
//
// Both audits need a rendering engine to compute real on-screen geometry
// (which this app has none of otherwise — see accessibility.js's own gap
// doc), so unlike fetchCoreWebVitals there is no lab/field distinction and
// no fallback: PSI's Lighthouse run IS the only source, always labeled
// 'lab' (a single simulated run), never invented when it fails.
export async function fetchMobileUsabilityAudit(pageUrl, { strategy = 'mobile' } = {}) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) throw new Error('PAGESPEED_API_KEY is not set — mobile usability audits cannot be fetched.');

  const url = `${ENDPOINT}?url=${encodeURIComponent(pageUrl)}&key=${key}&strategy=${strategy}&category=seo`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let body;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `PageSpeed Insights request failed: HTTP ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(timeout);
  }

  const audits = body?.lighthouseResult?.audits;
  if (!audits) return { ok: false, error: 'no lab data returned' };

  // Lighthouse scores every audit 0..1 (1 = fully passing) or null when the
  // audit is genuinely not applicable to this page (e.g. no tappable
  // elements at all) — null is passed through as null, never coerced to a
  // score, so a page with nothing to check reads as "not applicable", not
  // as a passing or failing result it never earned.
  const tapTargets = audits['tap-targets'];
  const fontSize = audits['font-size'];
  return {
    ok: true,
    dataSource: 'lab',
    tapTargets: {
      score: tapTargets?.score ?? null,
      // items: the real failing elements Lighthouse found (selector + size),
      // capped defensively — PSI can return dozens for a dense mobile nav.
      failingElements: (tapTargets?.details?.items || []).slice(0, 10),
    },
    fontSize: {
      score: fontSize?.score ?? null,
      // Lighthouse's own human-readable summary, e.g. "97% legible text" —
      // the real percentage of the page's text PSI measured as legible,
      // straight from its audit output, never recomputed here.
      summary: typeof fontSize?.displayValue === 'string' ? fontSize.displayValue : null,
      // Same real per-element detail as tapTargets.failingElements above —
      // Lighthouse's font-size audit table also lists the real failing text
      // nodes (each carrying a Lighthouse node-details object with its own
      // .snippet) when the audit fails, not just the aggregate percentage.
      // Passed through raw/uninterpreted, same discipline as tapTargets:
      // this file's job is fetching PSI's real output, never reshaping it
      // into a guessed contract the actual API might not match.
      failingElements: (fontSize?.details?.items || []).slice(0, 10),
    },
  };
}
