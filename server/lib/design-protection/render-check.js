// RENDER BEFORE / AFTER, in the client's real template, at 1440 and 390. The page is loaded live, measured, the change is put where it will really land
// (inside its SEOAI marker, at the end of the body region for a first insertion, or as the whole body region for a new page), and everything is
// measured again IN THE SAME PAGE. Each viewport is a fresh navigation, so one viewport's DOM edit never leaks into the other.
//
// Reads only (GET). Nothing is written to the client's site or repository. A page that cannot be loaded, or has no body region, is reported as such:
// that is "could not check", which decide.js turns into awaiting-verification, never into a pass.
import { launchBrowser } from '../../design-agent/live-analysis/capture.js';
import { measureBodyInPage, MEASURE_VIEWPORTS } from '../../design-agent/live-analysis/body-measure.js';
import { measureInsertedBlockInPage, snapshotOutsideInPage, injectBlockInPage } from './tokens.js';
import { compareBlockToBaseline, compareOutside, headingIssues, overflowRegression } from './compare.js';

/**
 * @param {object} a
 *   pageUrl   the real page the change lands on (or the template's reference page for a new page)
 *   html      the exact markup about to be published
 *   mode      'marker' | 'append' | 'region'
 *   marker    SEOAI marker name for mode 'marker' (e.g. 'FAQ')
 *   baseline  the template baseline row (tokens per viewport, vocabulary, patterns)
 * @returns {Promise<{status:'ok'|'unreachable'|'no-region'|'error', deviations?, outside?, heading?, overflow?, evidence?, error?}>}
 */
export async function runDesignRenderCheck({ pageUrl, html, mode = 'marker', marker = null, baseline, viewports = MEASURE_VIEWPORTS, launchBrowserFn = launchBrowser, navTimeoutMs = 20000 } = {}) {
  if (!pageUrl || html == null || !baseline) return { status: 'error', error: 'pageUrl, html and a baseline are required.' };
  let browser;
  try { browser = await launchBrowserFn(); } catch (err) { return { status: 'unreachable', error: err.message }; }
  const out = { status: 'ok', deviations: [], outside: [], heading: [], overflow: [], evidence: { pageUrl, mode, marker, viewports: {} } };
  try {
    for (const vp of viewports) {
      // eslint-disable-next-line no-await-in-loop
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      try {
        // eslint-disable-next-line no-await-in-loop
        const page = await context.newPage();
        try { await page.goto(pageUrl, { waitUntil: 'load', timeout: navTimeoutMs }); } catch (err) { return { status: 'unreachable', error: err.message, evidence: out.evidence }; }
        // eslint-disable-next-line no-await-in-loop
        const body = await page.evaluate(measureBodyInPage, true);
        if (mode !== 'marker' && !body?.found) return { status: 'no-region', error: 'the page has no body region to put the change in', evidence: out.evidence };
        // eslint-disable-next-line no-await-in-loop
        const before = await page.evaluate(snapshotOutsideInPage, [mode === 'marker' ? marker : null, mode === 'region']);
        // eslint-disable-next-line no-await-in-loop
        const injected = await page.evaluate(injectBlockInPage, [mode, marker, html]);
        if (!injected) return { status: 'no-region', error: mode === 'marker' ? `the page has no ${marker} marker to put the change in` : 'no body region', evidence: out.evidence };
        // eslint-disable-next-line no-await-in-loop
        const after = await page.evaluate(snapshotOutsideInPage, [mode === 'marker' ? marker : null, mode === 'region']);
        // eslint-disable-next-line no-await-in-loop
        const block = await page.evaluate(measureInsertedBlockInPage);
        out.deviations.push(...compareBlockToBaseline(block, baseline, vp.name));
        out.outside.push(...compareOutside(before, after).map((d) => ({ ...d, viewport: vp.name })));
        out.heading.push(...headingIssues(before.heading, after.heading, block).map((d) => ({ ...d, viewport: vp.name })));
        if (vp.name === 'mobile') out.overflow.push(...overflowRegression(before.overflow, after.overflow).map((d) => ({ ...d, viewport: vp.name })));
        out.evidence.viewports[vp.name] = { text: block.text, headings: block.headings, maxWidth: block.maxWidth, gapBefore: block.gapBefore, outsideElements: before.count, overflowing: block.overflowing };
      } finally { await context.close().catch(() => {}); }
    }
    return out;
  } catch (err) {
    return { status: 'error', error: err.message, evidence: out.evidence };
  } finally {
    await browser.close().catch(() => {});
  }
}
