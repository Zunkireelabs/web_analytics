import { marked } from 'marked';
import { launchBrowser } from '../../design-agent/live-analysis/capture.js';
import {
  measureBodyInPage, injectBodyInPage, compareBodyMeasures, MEASURE_VIEWPORTS,
} from '../../design-agent/live-analysis/body-measure.js';

// Does a net-new page, rendered into a REAL page of the same role on the same
// site, measure like that site? The pre-ship check whole-page generation never
// had: checkResponsivePreview has exactly one caller and is for splicing into
// an existing page, so every net-new page shipped unverified.
//
// Mechanism: load a real existing page of the same role, measure what the SITE
// does (heading scale, body size, line height, paragraph gaps, line length,
// rules), swap that page's body region for the draft, and measure what the
// DRAFT does in the very same region. Compared against a real page, never
// against absolutes — a site's own scale is the only valid yardstick.
//
// Result contract (same family as checkResponsivePreview):
//   { ok:true, broken:false }                 — matches
//   { ok:true, broken:true, deviations }      — measurably does not match
//   { ok:true, skip:true, reason }            — could not compare (no reference
//                                               page, un-renderable body)
//   { ok:false, reason:'unreachable', error } — infrastructure, not evidence

// Role -> the captured page types that make a valid reference.
const REFERENCE_TYPES = {
  'inline-article': ['blog-article', 'legal'],
  'section-page': ['service', 'landing', 'location', 'other', 'homepage'],
};

export function pickReferencePage(profile, role, permalink = null, { pageType = null } = {}) {
  const types = REFERENCE_TYPES[role];
  if (!types) return null;
  const pages = (profile?.pages || []).filter((p) => p?.url && types.includes(p.pageType));
  if (!pages.length) return null;
  const segment = (u) => { try { return new URL(u, 'https://x.invalid').pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } };
  const want = permalink ? segment(permalink) : '';
  // Most specific first, so a new Feature page is compared with a real
  // Feature page and not merely "a section page":
  //   1. same site section (the tenant's own family: /features/, /solutions/)
  //   2. same classified page type, when the caller knows it
  //   3. any page of a valid type
  // /recursos/ posts are best compared with other /recursos/ posts, whose
  // layout they will actually share.
  return (pages.find((p) => want && segment(p.url) === want)
    || pages.find((p) => pageType && p.pageType === pageType)
    || pages[0]).url;
}

// The draft body as the browser needs it: HTML. The rendered body is front
// matter plus a mix of projected HTML and leftover markdown, so front matter
// is dropped and the rest run through marked (which passes HTML blocks
// through untouched). Template syntax cannot be rendered outside the client's
// build, and JSX is not HTML at all — both are skipped, never faked.
export function renderableBody(rendered, contentFormat = 'markdown') {
  if (contentFormat === 'jsx') return { skip: true, reason: 'jsx-not-renderable' };
  const text = String(rendered ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  if (/\{%|\{\{/.test(text)) return { skip: true, reason: 'template-syntax' };
  if (!text.trim()) return { skip: true, reason: 'empty-body' };
  return { html: marked.parse(text, { async: false }) };
}

export async function checkNewPageRender({
  referenceUrl, newPageHtml, viewports = MEASURE_VIEWPORTS, launchBrowserFn = launchBrowser, navTimeoutMs = 20000,
} = {}) {
  if (!referenceUrl || newPageHtml == null) return { ok: false, error: 'referenceUrl and newPageHtml are required.' };

  let browser;
  try { browser = await launchBrowserFn(); } catch (err) { return { ok: false, reason: 'unreachable', error: err.message }; }

  try {
    const context = await browser.newContext({ viewport: { width: viewports[0].width, height: viewports[0].height } });
    const page = await context.newPage();
    try {
      await page.goto(referenceUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    } catch (err) {
      return { ok: false, reason: 'unreachable', referenceUrl, error: err.message };
    }

    // What the site does, at every viewport, with the region marked once.
    const ref = {};
    for (const vp of viewports) {
      // eslint-disable-next-line no-await-in-loop
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // eslint-disable-next-line no-await-in-loop
      ref[vp.name] = await page.evaluate(measureBodyInPage, true);
    }
    if (!ref[viewports[0].name]?.found) return { ok: true, skip: true, reason: 'no-body-region-on-reference' };

    const injected = await page.evaluate(injectBodyInPage, newPageHtml);
    if (!injected) return { ok: true, skip: true, reason: 'no-body-region-on-reference' };

    const deviations = [];
    for (const vp of viewports) {
      // eslint-disable-next-line no-await-in-loop
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // eslint-disable-next-line no-await-in-loop
      const draft = await page.evaluate(measureBodyInPage, false);
      deviations.push(...compareBodyMeasures(ref[vp.name], draft, vp));
    }
    return { ok: true, broken: deviations.length > 0, deviations, referenceUrl };
  } catch (err) {
    return { ok: false, reason: 'unreachable', error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Turn a gate result into a decision. Separated so the POLICY is one pure,
// tested function:
//   deviation              -> block 'render-deviation'
//   no reference page      -> block 'no-reference-page' (route to a human —
//                             never a silent ship)
//   unreachable            -> infrastructure is not evidence, so allow, UNLESS
//                             role confidence is low: then it is not
//                             permission to ship unverified typography either
//   other skip             -> allow (the check could not apply)
export function renderGateVerdict(result, { roleConfidence = 'high', hasReference = true } = {}) {
  if (!hasReference) return { blocked: true, reason: 'no-reference-page', detail: { humanReview: true } };
  if (!result) return { blocked: false, reason: 'not-run' };
  if (result.ok && result.broken) return { blocked: true, reason: 'render-deviation', detail: { deviations: result.deviations, referenceUrl: result.referenceUrl } };
  if (result.ok) return { blocked: false, reason: result.skip ? result.reason : 'matches' };
  if (result.reason === 'unreachable') {
    return roleConfidence === 'low'
      ? { blocked: true, reason: 'unverifiable-low-confidence', detail: { error: result.error } }
      : { blocked: false, reason: 'unreachable', detail: { error: result.error } };
  }
  return { blocked: false, reason: 'not-run' };
}

export function isRenderGateEnabled(env = process.env) {
  return env.NEWPAGE_RENDER_GATE_ENABLED === 'true';
}
