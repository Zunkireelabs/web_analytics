// CAPTURE A TEMPLATE BASELINE. Measures live pages of ONE template of ONE project, at 1440 and 390, after removing platform-written SEOAI marker content
// and cookie/consent/fixed overlays, and keeps what the pages AGREE on. Two or more agreeing samples make a ready baseline; samples that disagree beyond
// tolerance make an UNSTABLE one (not usable: someone decides which page is the template); no body region at all is a failed capture. Nothing is invented:
// a measurement that was not taken is absent, and the reader (decide.js) treats absent as awaiting-baseline.
//
// Reads only (GET). `runProtectionBaselineQueue` is what the Design Agent's queue calls for rows in status 'requested'.
import { launchBrowser } from '../../design-agent/live-analysis/capture.js';
import { measureBodyInPage, MEASURE_VIEWPORTS } from '../../design-agent/live-analysis/body-measure.js';
import { prepareForBaselineInPage, measureTemplateExtrasInPage } from '../../lib/design-protection/tokens.js';
import { urlsForTemplateKey, absoluteUrls } from '../../lib/design-protection/template.js';
import { operatorDetail } from '../../lib/errors.js';

const median = (arr) => { const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
const modeOf = (arr) => { const c = new Map(); for (const v of arr.filter((x) => x != null)) c.set(JSON.stringify(v), (c.get(JSON.stringify(v)) || 0) + 1); let best = null; let top = 0; for (const [v, k] of c) if (k > top) { best = JSON.parse(v); top = k; } return best; };
const off = (a, b, tol) => a > 0 && b > 0 && Math.abs(b - a) / a > tol;

/** Pure. One viewport's token set from one page's two measurements. */
export function tokensFromMeasures(body, extras) {
  if (!body?.found || !extras?.found) return null;
  const el = (m, x) => (m || x) ? { fontSize: m?.fontSize ?? x?.fontSize ?? null, fontWeight: String(m?.fontWeight ?? x?.fontWeight ?? ''), lineHeightRatio: m?.lineHeightRatio ?? null, family: x?.family ?? null, color: x?.color ?? null } : null;
  return { p: el(body.p, extras.p), h2: el(body.h2, extras.h2), h3: el(body.h3, extras.h3), link: extras.link ? { color: extras.link.color } : null, background: extras.background, containerWidth: extras.containerWidth || body.regionWidth || null, radii: extras.radii || [] };
}

/** Pure. Merge per-page token sets (one viewport) by median/mode, and list where pages disagree beyond tolerance. */
export function mergeSamples(samples, viewport) {
  const ok = samples.filter(Boolean);
  const merged = {}; const disagreements = [];
  const num = (path, get, tol) => { const vals = ok.map(get); const med = median(vals); ok.forEach((s, i) => { if (off(med, vals[i], tol)) disagreements.push({ viewport, field: path, expected: med, actual: vals[i] }); }); return med; };
  const str = (path, get) => { const vals = ok.map(get); const m = modeOf(vals); ok.forEach((s, i) => { if (m != null && vals[i] != null && String(m).replace(/\s+/g, '') !== String(vals[i]).replace(/\s+/g, '')) disagreements.push({ viewport, field: path, expected: m, actual: vals[i] }); }); return m; };
  for (const k of ['p', 'h2', 'h3']) {
    if (!ok.some((s) => s[k])) continue;
    merged[k] = {
      fontSize: num(`${k}.fontSize`, (s) => s[k]?.fontSize, 0.15), lineHeightRatio: num(`${k}.lineHeightRatio`, (s) => s[k]?.lineHeightRatio, 0.15),
      fontWeight: str(`${k}.fontWeight`, (s) => s[k]?.fontWeight), family: str(`${k}.family`, (s) => s[k]?.family), color: str(`${k}.color`, (s) => s[k]?.color),
    };
  }
  merged.link = ok.some((s) => s.link) ? { color: modeOf(ok.map((s) => s.link?.color)) } : null;
  merged.background = modeOf(ok.map((s) => s.background));
  merged.containerWidth = num('containerWidth', (s) => s.containerWidth, 0.2);
  merged.radii = [...new Set(ok.flatMap((s) => s.radii || []))].sort((a, b) => a - b);
  return { merged, disagreements };
}

/** Pure. Union patterns, element classes and vocabulary across pages of the template. */
export function mergePatterns(extrasList) {
  const ok = extrasList.filter((e) => e?.found);
  const patterns = {};
  for (const kind of ['faq', 'table', 'related-links', 'breadcrumbs']) {
    const present = ok.map((e) => e.patterns?.[kind]).filter((p) => p?.present);
    patterns[kind] = present.length ? { ...present[0], present: true } : { present: false };
  }
  const elementClasses = {};
  for (const k of ['h2', 'h3', 'p', 'ul', 'ol', 'table', 'blockquote', 'a', 'details', 'summary']) { const seen = ok.map((e) => e.elementClasses?.[k]).filter((v) => v !== undefined); if (seen.length) elementClasses[k] = modeOf(seen); }
  patterns.elementClasses = elementClasses;
  const vocabulary = [...new Set(ok.flatMap((e) => e.vocabulary || []))].slice(0, 600);
  return { patterns, vocabulary };
}

export async function captureTemplateBaseline({ urls, viewports = MEASURE_VIEWPORTS, launchBrowserFn = launchBrowser, navTimeoutMs = 20000 } = {}) {
  if (!urls?.length) return { status: 'failed', error: 'the template has no live pages to measure' };
  let browser;
  try { browser = await launchBrowserFn(); } catch (err) { return { status: 'failed', error: `no browser: ${operatorDetail(err)}` }; }
  const perViewport = Object.fromEntries(viewports.map((v) => [v.name, []]));
  const extrasDesktop = []; const sampled = []; const errors = [];
  try {
    for (const url of urls) {
      let usable = false;
      for (const vp of viewports) {
        // eslint-disable-next-line no-await-in-loop
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        try {
          // eslint-disable-next-line no-await-in-loop
          const page = await context.newPage();
          // eslint-disable-next-line no-await-in-loop
          try { await page.goto(url, { waitUntil: 'load', timeout: navTimeoutMs }); } catch (err) { errors.push(`${url}: ${operatorDetail(err)}`); continue; }
          // eslint-disable-next-line no-await-in-loop
          await page.evaluate(prepareForBaselineInPage);
          // eslint-disable-next-line no-await-in-loop
          const body = await page.evaluate(measureBodyInPage, true);
          // eslint-disable-next-line no-await-in-loop
          const extras = body?.found ? await page.evaluate(measureTemplateExtrasInPage) : null;
          const t = tokensFromMeasures(body, extras);
          if (t) { perViewport[vp.name].push(t); usable = true; if (vp.name === viewports[0].name) extrasDesktop.push(extras); }
        } finally { await context.close().catch(() => {}); }
      }
      if (usable) sampled.push(url);
    }
  } finally { await browser.close().catch(() => {}); }
  if (!sampled.length) return { status: 'failed', error: errors[0] || 'no page of the template had a body region to measure' };
  const tokens = {}; const disagreements = [];
  for (const vp of viewports) { const { merged, disagreements: d } = mergeSamples(perViewport[vp.name], vp.name); tokens[vp.name] = merged; disagreements.push(...d); }
  const { patterns, vocabulary } = mergePatterns(extrasDesktop);
  const base = { tokens, patterns, vocabulary, sampleUrls: sampled, disagreements: disagreements.length ? disagreements : null };
  if (disagreements.length) return { ...base, status: 'unstable', confidence: 'samples-disagree' };
  return { ...base, status: 'ready', confidence: sampled.length >= 2 ? 'agreeing-samples' : 'single-sample' };
}

/**
 * Processes requested baselines. `loadSite(siteId)` returns the site row (profile + domain). One project failing never stops the others.
 * Safe to run from the Design Agent's queue: it only reads client pages and writes design_baselines.
 */
export async function runProtectionBaselineQueue({ limit = 5, deps = {} } = {}) {
  const store = deps.store || await import('../../lib/design-protection/store.js');
  const loadSite = deps.loadSite || (async (id) => (await import('../../store/read.js')).getSiteById(id));
  const originOf = deps.originOf || (await import('../../agents/lib/site-domain.js')).siteOriginFor;
  const capture = deps.capture || captureTemplateBaseline;
  const rows = await store.listRequestedBaselines({ limit });
  const results = [];
  for (const row of rows) {
    try {
      const site = await loadSite(row.site_id);
      const profile = site?.url_file_map?.siteRoot?.designProfile || null;
      const urls = absoluteUrls(urlsForTemplateKey(profile, row.template_key), originOf(site));
      const r = await capture({ urls });
      await store.saveBaseline(row.site_id, row.template_key, { status: r.status, tokens: r.tokens || null, patterns: r.patterns || null, vocabulary: r.vocabulary || null, sampleUrls: r.sampleUrls || null, confidence: r.confidence || null, disagreements: r.disagreements || null, error: r.error || null });
      results.push({ siteId: row.site_id, templateKey: row.template_key, status: r.status, samples: r.sampleUrls?.length || 0, error: r.error || null });
    } catch (err) {
      await store.saveBaseline(row.site_id, row.template_key, { status: 'failed', error: err.message }).catch(() => {});
      results.push({ siteId: row.site_id, templateKey: row.template_key, status: 'failed', error: err.message });
    }
  }
  return results;
}
