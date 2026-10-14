import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickReferencePage, renderableBody, checkNewPageRender, renderGateVerdict } from './newpage-render-gate.js';

const profile = { pages: [
  { url: 'https://x.com/', pageType: 'homepage' },
  { url: 'https://x.com/blog/a', pageType: 'blog-article' },
  { url: 'https://x.com/recursos/b', pageType: 'blog-article' },
  { url: 'https://x.com/services/c', pageType: 'service' },
] };

describe('pickReferencePage', () => {
  test('an article is compared with an article, preferring the same section of the site', () => {
    assert.equal(pickReferencePage(profile, 'inline-article', '/recursos/new/'), 'https://x.com/recursos/b');
    assert.equal(pickReferencePage(profile, 'inline-article', '/zzz/new/'), 'https://x.com/blog/a');
  });
  test('a section page is compared with a section page, never an article', () => {
    assert.equal(pickReferencePage(profile, 'section-page'), 'https://x.com/');
  });
  test('no comparable page, or an unknown role, is null', () => {
    assert.equal(pickReferencePage({ pages: [{ url: 'u', pageType: 'service' }] }, 'inline-article'), null);
    assert.equal(pickReferencePage(profile, 'unknown'), null);
    assert.equal(pickReferencePage(null, 'inline-article'), null);
  });
});

describe('renderableBody', () => {
  test('front matter is dropped and markdown becomes HTML', () => {
    const r = renderableBody('---\ntitle: x\n---\n\n## Hello\n\nSome <b>text</b>.');
    assert.match(r.html, /<h2[^>]*>Hello<\/h2>/);
    assert.match(r.html, /<b>text<\/b>/);
  });
  test('already-projected HTML passes through untouched', () => {
    assert.match(renderableBody('<h2 class="text-2xl">Hi</h2>\n<p class="x">body</p>').html, /<h2 class="text-2xl">Hi<\/h2>/);
  });
  test('JSX and template syntax are skipped, never faked', () => {
    assert.equal(renderableBody('export default x', 'jsx').reason, 'jsx-not-renderable');
    assert.equal(renderableBody('{% include "x" %}').reason, 'template-syntax');
    assert.equal(renderableBody('---\na: b\n---\n').reason, 'empty-body');
  });
});

const fakeBrowser = ({ ref, draft, gotoFails = false, injectOk = true }) => async () => {
  let evals = 0;
  return {
    newContext: async () => ({ newPage: async () => ({
      goto: async () => { if (gotoFails) throw new Error('timeout'); },
      setViewportSize: async () => {},
      evaluate: async (fn) => {
        if (fn.name === 'injectBodyInPage') return injectOk;
        evals++;
        return evals <= 2 ? ref : draft;
      },
    }) }),
    close: async () => {},
  };
};
const meas = (h2) => ({ found: true, h2: { fontSize: h2, borderBottom: 0 }, p: { fontSize: 18, lineHeightRatio: 1.7 }, paragraphGap: 24, lineChars: 70, horizontalOverflow: false });

describe('checkNewPageRender', () => {
  test('a matching draft is ok and not broken', async () => {
    const r = await checkNewPageRender({ referenceUrl: 'u', newPageHtml: '<p>x</p>', launchBrowserFn: fakeBrowser({ ref: meas(28), draft: meas(28) }) });
    assert.equal(r.ok, true);
    assert.equal(r.broken, false);
  });
  test('the reported bug — 48px headings on a 28px site — is broken, with the numbers', async () => {
    const r = await checkNewPageRender({ referenceUrl: 'u', newPageHtml: '<p>x</p>', launchBrowserFn: fakeBrowser({ ref: meas(28), draft: meas(48) }) });
    assert.equal(r.broken, true);
    assert.equal(r.deviations[0].kind, 'heading-scale');
    assert.deepEqual([r.deviations[0].expected, r.deviations[0].actual], [28, 48]);
  });
  test('a reference with no body region is a skip, not a pass or a fail', async () => {
    const r = await checkNewPageRender({ referenceUrl: 'u', newPageHtml: 'x', launchBrowserFn: fakeBrowser({ ref: { found: false }, draft: {} }) });
    assert.deepEqual([r.ok, r.skip, r.reason], [true, true, 'no-body-region-on-reference']);
  });
  test('an unreachable reference is infrastructure, reported as such', async () => {
    const r = await checkNewPageRender({ referenceUrl: 'u', newPageHtml: 'x', launchBrowserFn: fakeBrowser({ gotoFails: true }) });
    assert.deepEqual([r.ok, r.reason], [false, 'unreachable']);
  });
  test('no browser is unreachable, not a throw', async () => {
    const r = await checkNewPageRender({ referenceUrl: 'u', newPageHtml: 'x', launchBrowserFn: async () => { throw new Error('no chromium'); } });
    assert.equal(r.reason, 'unreachable');
  });
  test('missing inputs are refused up front', async () => {
    assert.equal((await checkNewPageRender({})).ok, false);
  });
});

describe('renderGateVerdict — the policy', () => {
  test('a measured deviation blocks, carrying the evidence', () => {
    const v = renderGateVerdict({ ok: true, broken: true, deviations: [{ kind: 'heading-scale' }], referenceUrl: 'u' });
    assert.deepEqual([v.blocked, v.reason], [true, 'render-deviation']);
    assert.equal(v.detail.deviations.length, 1);
  });
  test('no comparable reference page blocks and routes to a human — never a silent ship', () => {
    const v = renderGateVerdict(null, { hasReference: false });
    assert.deepEqual([v.blocked, v.reason, v.detail.humanReview], [true, 'no-reference-page', true]);
  });
  test('infrastructure failure is not evidence, so it allows — unless role confidence is low', () => {
    const down = { ok: false, reason: 'unreachable', error: 'x' };
    assert.equal(renderGateVerdict(down, { roleConfidence: 'high' }).blocked, false);
    assert.equal(renderGateVerdict(down, { roleConfidence: 'medium' }).blocked, false);
    assert.equal(renderGateVerdict(down, { roleConfidence: 'low' }).reason, 'unverifiable-low-confidence');
  });
  test('a match and a could-not-apply skip both allow', () => {
    assert.equal(renderGateVerdict({ ok: true, broken: false }).blocked, false);
    assert.equal(renderGateVerdict({ ok: true, skip: true, reason: 'jsx-not-renderable' }).blocked, false);
  });
});

describe('pickReferencePage — most specific reference first', () => {
  const profile = { pages: [
    { url: 'https://a.com/services/x', pageType: 'service' },
    { url: 'https://a.com/landing/y', pageType: 'landing' },
    { url: 'https://a.com/features/z', pageType: 'service' },
  ] };
  test('same site section beats everything', () => {
    assert.equal(pickReferencePage(profile, 'section-page', '/features/new/'), 'https://a.com/features/z');
  });
  test('with no matching section, the classified page type is used', () => {
    assert.equal(pickReferencePage(profile, 'section-page', '/other/new/', { pageType: 'landing' }), 'https://a.com/landing/y');
  });
  test('with neither, falls back to the first valid page as before', () => {
    assert.equal(pickReferencePage(profile, 'section-page', '/other/new/'), 'https://a.com/services/x');
  });
});
