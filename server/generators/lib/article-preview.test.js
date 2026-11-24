import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderArticlePreview, injectArticleInPage } from './article-preview.js';
import { measureBodyInPage } from '../../design-agent/live-analysis/body-measure.js';

const refMeasure = { found: true, h2: { fontSize: 32, borderBottom: 0 }, p: { fontSize: 18, lineHeightRatio: 1.7 }, paragraphGap: 24, lineChars: 70, horizontalOverflow: false };

// A stand-in browser. `measures` are what measureBodyInPage returns in order (reference desktop, reference mobile, draft desktop, draft mobile).
function fakeBrowser({ measures, injected = { body: true, title: true, hero: false }, gotoFails = false }) {
  const calls = { goto: [], shots: 0, closed: false, injectArgs: null };
  let m = 0;
  const page = {
    goto: async (url) => { calls.goto.push(url); if (gotoFails) throw new Error('net::ERR_NAME_NOT_RESOLVED'); },
    setViewportSize: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => { calls.shots++; return Buffer.from('png'); },
    evaluate: async (fn, arg) => {
      if (fn === measureBodyInPage) return measures[m++];
      if (fn === injectArticleInPage) { calls.injectArgs = arg; return injected; }
      return { w: 1440, h: 3000 };
    },
  };
  return { calls, launch: async () => ({ newContext: async () => ({ newPage: async () => page }), close: async () => { calls.closed = true; } }) };
}

describe('renderArticlePreview', () => {
  test('a draft that measures like the site: screenshots at both widths, matches the design', async () => {
    const b = fakeBrowser({ measures: [refMeasure, refMeasure, refMeasure, refMeasure] });
    const r = await renderArticlePreview({ referenceUrl: 'https://x.test/blog/a/', bodyHtml: '<p>x</p>', title: 'T', launchBrowserFn: b.launch });
    assert.equal(r.ok, true);
    assert.deepEqual(r.shots.map((s) => s.viewport), ['desktop', 'mobile']);
    assert.equal(r.matchesSiteDesign, true);
    assert.deepEqual(r.deviations, []);
    assert.equal(b.calls.shots, 2);
    assert.equal(b.calls.closed, true, 'the browser is always closed');
    assert.deepEqual(b.calls.injectArgs, { html: '<p>x</p>', title: 'T', cover: null });
  });

  test('a flat render (headings no bigger than body text) is reported as deviating, never as a success', async () => {
    const flat = { ...refMeasure, h2: { fontSize: 18, borderBottom: 0 } };
    const b = fakeBrowser({ measures: [refMeasure, refMeasure, flat, flat] });
    const r = await renderArticlePreview({ referenceUrl: 'https://x.test/blog/a/', bodyHtml: '<p>x</p>', launchBrowserFn: b.launch });
    assert.equal(r.matchesSiteDesign, false);
    assert.ok(r.deviations.some((d) => d.kind === 'heading-scale'));
  });

  test('a reference page with no article body region is skipped honestly (no screenshot, nothing faked)', async () => {
    const b = fakeBrowser({ measures: [{ found: false }, { found: false }] });
    const r = await renderArticlePreview({ referenceUrl: 'https://x.test/', bodyHtml: '<p>x</p>', launchBrowserFn: b.launch });
    assert.deepEqual([r.ok, r.skip, r.reason], [true, true, 'no-body-region-on-reference']);
    assert.equal(b.calls.shots, 0);
    assert.equal(b.calls.closed, true);
  });

  test('an unreachable reference is infrastructure, not evidence', async () => {
    const b = fakeBrowser({ measures: [], gotoFails: true });
    const r = await renderArticlePreview({ referenceUrl: 'https://nope.test/', bodyHtml: '<p>x</p>', launchBrowserFn: b.launch });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unreachable');
    assert.equal(b.calls.closed, true);
  });

  test('no browser available is reported, not thrown', async () => {
    const r = await renderArticlePreview({ referenceUrl: 'https://x.test/', bodyHtml: '<p>x</p>', launchBrowserFn: async () => { throw new Error('no chromium'); } });
    assert.deepEqual([r.ok, r.reason], [false, 'unreachable']);
  });

  test('missing input is refused up front', async () => {
    assert.equal((await renderArticlePreview({ bodyHtml: '<p>x</p>' })).reason, 'bad-input');
    assert.equal((await renderArticlePreview({ referenceUrl: 'https://x.test/' })).reason, 'bad-input');
  });
});
