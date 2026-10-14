import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkResponsivePreview, describeResponsiveRegressions } from './responsive-preview-gate.js';

// A fake Playwright browser/context/page — real chromium is exercised
// separately (see the smoke-test describe block at the bottom, skipped in
// CI-style runs without a browser available). Here, `evaluate(fn, arg)` is
// distinguished purely by the SHAPE of `arg`: an array means this is the
// injectMarkerContent call ([marker, html]); anything else (a number) means
// this is a measureResponsiveInPage call — the exact same distinction the
// real module's two call sites make, so the mock never has to know about
// the actual function identities/serialization Playwright handles for real.
function fakeBrowser({
  gotoError = null,
  measurements, // array of per-call measurement objects, consumed in order
  injected = true,
} = {}) {
  const calls = { setViewportSize: [], evaluateMeasure: 0 };
  let measureIndex = 0;
  const page = {
    goto: async () => { if (gotoError) throw new Error(gotoError); },
    setViewportSize: async (size) => { calls.setViewportSize.push(size); },
    evaluate: async (fn, arg) => {
      if (Array.isArray(arg)) return injected; // injectMarkerContent([marker, html])
      calls.evaluateMeasure++;
      return measurements[measureIndex++];
    },
  };
  const context = { newPage: async () => page };
  const browser = {
    newContext: async () => context,
    close: async () => {},
    _calls: calls,
  };
  return { launchBrowserFn: async () => browser, browser };
}

function measurement({ overflowPx = 0, overflowingElements = [], clippedElements = [], smallTapTargets = [] } = {}) {
  return { overflowPx, overflowingElements, clippedElements, smallTapTargets };
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'mobile', width: 390, height: 844 },
];

const BASE_OPTS = { pageUrl: 'https://example.com/blog/post/', marker: 'FAQ', newContentHtml: '<dl><dt>Q?</dt><dd>A.</dd></dl>', viewports: VIEWPORTS };

describe('checkResponsivePreview', () => {
  test('no regression: before and after measurements are identical at every viewport', async () => {
    const clean = measurement();
    const { launchBrowserFn } = fakeBrowser({ measurements: [clean, clean, clean, clean, clean, clean] });
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.ok, true);
    assert.equal(result.broken, false);
    assert.deepEqual(result.regressions, []);
  });

  test('flags NEW horizontal overflow introduced only at the mobile viewport', async () => {
    const clean = measurement();
    const overflowing = measurement({ overflowPx: 40, overflowingElements: [{ tag: 'dt', outerHtml: '<dt>...</dt>' }] });
    // 3 "before" measurements (desktop/tablet/mobile, all clean), then
    // 3 "after" measurements (desktop/tablet clean, mobile now overflowing).
    const { launchBrowserFn } = fakeBrowser({ measurements: [clean, clean, clean, clean, clean, overflowing] });
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.ok, true);
    assert.equal(result.broken, true);
    assert.equal(result.regressions.length, 1);
    assert.equal(result.regressions[0].kind, 'horizontal-overflow');
    assert.equal(result.regressions[0].viewport, 'mobile');
    assert.equal(result.regressions[0].overflowPx, 40);
  });

  test('a page that ALREADY overflows, unchanged by this draft, is not flagged (before/after, not absolute)', async () => {
    // The exact case checkTemplateStructuralMatch's own module comment warns
    // about in the other direction: a pre-existing defect must never be
    // blamed on the draft that happened to be checked next to it.
    const alreadyBroken = measurement({ overflowPx: 60 });
    const { launchBrowserFn } = fakeBrowser({ measurements: [alreadyBroken, alreadyBroken, alreadyBroken, alreadyBroken, alreadyBroken, alreadyBroken] });
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.broken, false);
  });

  test('a meaningful INCREASE on top of pre-existing overflow is still a real regression', async () => {
    const before = measurement({ overflowPx: 60 });
    const after = measurement({ overflowPx: 130 }); // +70px, well past tolerance
    const { launchBrowserFn } = fakeBrowser({ measurements: [before, before, before, before, before, after] });
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.broken, true);
    assert.equal(result.regressions[0].wasAlready, 60);
  });

  test('a tiny sub-pixel difference is within tolerance, not a regression', async () => {
    const before = measurement({ overflowPx: 10 });
    const after = measurement({ overflowPx: 11 }); // +1px
    const { launchBrowserFn } = fakeBrowser({ measurements: [before, before, before, before, before, after] });
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.broken, false);
  });

  test('a genuinely new clipped element is flagged; one that was already clipped before is not', async () => {
    const preExisting = { tag: 'span', outerHtml: '<span class="old">already clipped</span>' };
    const brandNew = { tag: 'p', outerHtml: '<p class="new">newly clipped</p>' };
    const before = measurement({ clippedElements: [preExisting] });
    const after = measurement({ clippedElements: [preExisting, brandNew] });
    const { launchBrowserFn } = fakeBrowser({ measurements: [before, before, before, before, before, after] });
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.broken, true);
    const clip = result.regressions.find((r) => r.kind === 'clipped-content');
    assert.equal(clip.elements.length, 1);
    assert.equal(clip.elements[0].outerHtml, brandNew.outerHtml);
  });

  test('a new undersized tap target is flagged', async () => {
    const before = measurement();
    const tiny = { tag: 'a', outerHtml: '<a href="#">x</a>', minSide: 18 };
    const after = measurement({ smallTapTargets: [tiny] });
    const { launchBrowserFn } = fakeBrowser({ measurements: [before, before, before, before, before, after] });
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.broken, true);
    assert.equal(result.regressions[0].kind, 'undersized-tap-target');
  });

  test('no SEOAI marker found on the page -> skip, never a false failure', async () => {
    const clean = measurement();
    const { launchBrowserFn } = fakeBrowser({ measurements: [clean, clean, clean], injected: false });
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.ok, true);
    assert.equal(result.skip, true);
    assert.equal(result.reason, 'no-marker-found');
  });

  test('an unreachable page fails as unreachable, never as broken', async () => {
    const { launchBrowserFn } = fakeBrowser({ gotoError: 'net::ERR_CONNECTION_REFUSED' });
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreachable');
    assert.match(result.error, /ERR_CONNECTION_REFUSED/);
  });

  test('a browser that fails to launch at all fails as unreachable, not a crash', async () => {
    const launchBrowserFn = async () => { throw new Error('no chromium binary'); };
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreachable');
  });

  test('missing required options is an honest error, no network attempted', async () => {
    let launched = false;
    const launchBrowserFn = async () => { launched = true; return {}; };
    const result = await checkResponsivePreview({ pageUrl: '', marker: 'FAQ', newContentHtml: '<p>x</p>', launchBrowserFn });
    assert.equal(result.ok, false);
    assert.equal(launched, false);
  });

  test('the browser is always closed, even when a mid-check evaluate throws', async () => {
    const { launchBrowserFn, browser } = fakeBrowser({ measurements: [] }); // runs out -> undefined.overflowPx throws
    let closed = false;
    browser.close = async () => { closed = true; };
    const result = await checkResponsivePreview({ ...BASE_OPTS, launchBrowserFn });
    assert.equal(result.ok, false);
    assert.equal(closed, true);
  });
});

describe('describeResponsiveRegressions', () => {
  test('null/empty regressions -> null, not an empty string', () => {
    assert.equal(describeResponsiveRegressions([]), null);
    assert.equal(describeResponsiveRegressions(null), null);
  });

  test('summarizes each regression kind in one readable sentence', () => {
    const summary = describeResponsiveRegressions([
      { kind: 'horizontal-overflow', viewport: 'mobile', width: 390, overflowPx: 40 },
      { kind: 'clipped-content', viewport: 'tablet', width: 834, elements: [{}, {}] },
      { kind: 'undersized-tap-target', viewport: 'mobile', width: 390, elements: [{}] },
    ]);
    assert.match(summary, /overflow at 390px \(mobile\) — 40px wider/);
    assert.match(summary, /clipped.*834px \(tablet\).*2 element/);
    assert.match(summary, /1 new undersized tap target.*390px \(mobile\)/);
  });
});
