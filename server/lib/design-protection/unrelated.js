// UNRELATED PAGES MUST NOT CHANGE. A change to a file many pages use (a layout, a partial, a component, a stylesheet) can damage pages nobody is looking
// at. Content-only edits cannot (they replace one page's own content). For a shared-file change, 2-3 OTHER pages of the same layout are rendered from the
// LIVE site (before) and from a BUILT PREVIEW of the change (after) and their structure/styling compared. Without a built preview the change cannot be
// judged, and decide.js holds it as awaiting-verification: a shared-file change is never assumed safe.
import { launchBrowser } from '../../design-agent/live-analysis/capture.js';
import { snapshotOutsideInPage } from './tokens.js';
import { compareOutside } from './compare.js';
import { MEASURE_VIEWPORTS } from '../../design-agent/live-analysis/body-measure.js';

/**
 * @param {{liveUrls:string[], previewUrlFor:(liveUrl:string)=>string|null}} a
 * @returns {Promise<{status:'none'|'same'|'differs'|'unreachable', detail?:string, diffs?:object[]}>}
 */
export async function checkUnrelatedPages({ liveUrls = [], previewUrlFor = null, viewports = MEASURE_VIEWPORTS, launchBrowserFn = launchBrowser, navTimeoutMs = 20000 } = {}) {
  if (typeof previewUrlFor !== 'function' || !liveUrls.length) return { status: 'none' };
  let browser;
  try { browser = await launchBrowserFn(); } catch (err) { return { status: 'unreachable', detail: err.message }; }
  const diffs = [];
  try {
    for (const live of liveUrls.slice(0, 3)) {
      const preview = previewUrlFor(live);
      if (!preview) return { status: 'none' };
      for (const vp of viewports) {
        // eslint-disable-next-line no-await-in-loop
        const snap = async (url) => { const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } }); try { const p = await ctx.newPage(); await p.goto(url, { waitUntil: 'load', timeout: navTimeoutMs }); return await p.evaluate(snapshotOutsideInPage, [null, false]); } finally { await ctx.close().catch(() => {}); } };
        let a; let b;
        // eslint-disable-next-line no-await-in-loop
        try { a = await snap(live); b = await snap(preview); } catch (err) { return { status: 'unreachable', detail: err.message }; }
        diffs.push(...compareOutside(a, b, { max: 3 }).map((d) => ({ ...d, page: live, viewport: vp.name })));
      }
    }
  } finally { await browser.close().catch(() => {}); }
  return diffs.length ? { status: 'differs', diffs, detail: `${diffs.length} difference(s), e.g. ${diffs[0].page}: ${diffs[0].detail}` } : { status: 'same' };
}
