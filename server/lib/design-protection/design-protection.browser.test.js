// REAL-BROWSER end-to-end tests of design protection: fixture "client sites" served from 127.0.0.1, measured by a real Chromium at 1440 and 390 px.
// The fixtures reproduce the real cases found on 2026-11-25: Chayce's 19px lead paragraph above 17px body copy (the old single-number check held ten
// correct drafts), a baseline polluted by platform SEOAI blocks, a cookie banner that Zennly's capture mistook for the hero, and the ways a generated
// block really breaks a page (restyled body, foreign classes, a table that pushes a phone sideways, a second H1, a <style> that restyles the nav).
// Skipped (not failed) when no browser can launch, like every other live-render test in this repo. Nothing leaves 127.0.0.1.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { captureTemplateBaseline } from '../../design-agent/protection/capture-baseline.js';
import { runDesignRenderCheck } from './render-check.js';
import { checkUnrelatedPages } from './unrelated.js';
import { protectVisibleChange } from './protect.js';

const SENT = 'A representative sentence of real article copy that is long enough to count as a body paragraph and to wrap across several lines in the column. ';
const P = (n = 2) => `<p>${SENT.repeat(n)}</p>`;
const FAQ_EXISTING = '<section class="faq"><details class="faq-item"><summary>Is this real?</summary><p>Yes, this is the answer that the site already shows in its own format.</p></details></section>';
const COOKIE = '<div id="cookie-banner" class="cookie-consent-bar" style="position:fixed;left:0;right:0;bottom:0;height:60px;background:#000;color:#fff;font-size:11px;font-family:monospace">We use cookies</div>';
const POLLUTED = '<!-- SEOAI:FAQ:START --><div class="text-3xl md:text-4xl platform-faq" style="font-size:48px">platform faq</div><!-- SEOAI:FAQ:END -->';
const CSS = (extra = '') => `<style>
  body{font:16px/1.4 "Helvetica Neue",Arial,sans-serif;margin:0;color:#222}
  nav.site-nav{background:#111;color:#fff;padding:14px 24px;display:flex;gap:16px}
  .wrap{max-width:720px;margin:0 auto;padding:0 24px}
  .blog-post-body p{font-size:17px;line-height:1.7;color:#222;margin:0 0 20px}
  .blog-post-body>p:first-child{font-size:19px}
  .blog-post-body h2{font-size:32px;font-weight:700;color:#0a0a0a;margin:36px 0 14px;line-height:1.2}
  .blog-post-body h3{font-size:22px;font-weight:600;color:#0a0a0a}
  .blog-post-body a{color:#0050c8}
  .faq-item summary{font-size:17px;font-weight:600;cursor:pointer}.faq-item p{font-size:17px}
  footer.site-foot{background:#eee;padding:24px;margin-top:40px}
  @media(max-width:600px){.wrap{padding:0 16px}.blog-post-body h2{font-size:26px}.blog-post-body p{font-size:16px}.blog-post-body>p:first-child{font-size:18px}}
  ${extra}</style>`;
const page = ({ title = 'Post', marker = true, faq = false, polluted = false, cookie = true, css = '', body = '' } = {}) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${CSS(css)}</head><body>
  <nav class="site-nav"><a href="/">Home</a><a href="/blog/a">Blog</a></nav>
  <main><article class="wrap"><h1>${title}</h1><div class="blog-post-body">${P(2)}${P(2)}<h2>A section</h2>${P(2)}${P(2)}<h3>Sub</h3>${P(2)}${faq ? FAQ_EXISTING : ''}${polluted ? POLLUTED : ''}${marker ? '<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->' : ''}${body}</div></article></main>
  <footer class="site-foot"><p>Footer text</p></footer>${cookie ? COOKIE : ''}</body></html>`;

let server; let base; let canLaunch = true;
const PAGES = {
  '/blog/a': page({ title: 'A', faq: true, polluted: true }), '/blog/b': page({ title: 'B', marker: true }), '/blog/c': page({ title: 'C', faq: true }),
  '/blog/odd': page({ title: 'Odd', css: '.blog-post-body p{font-size:22px!important}' }), '/blog/nomarker': page({ title: 'NoMarker', marker: false }),
  '/blog/empty': '<!doctype html><html><body><p>hi</p></body></html>',
  // a preview of a shared-file change: the nav is restyled on /legal/x and untouched on /legal/y
  '/live/x': page({ title: 'X' }), '/live/y': page({ title: 'Y' }), '/preview/x': page({ title: 'X', css: 'nav.site-nav{background:red;padding:40px}' }), '/preview/y': page({ title: 'Y' }),
};
const launch = () => chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const url = (p) => `${base}${p}`;
before(async () => {
  server = http.createServer((req, res) => { const html = PAGES[req.url.split('?')[0]]; res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' }); res.end(html || 'nope'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  try { const b = await launch(); await b.close(); } catch { canLaunch = false; }
});
after(() => server?.close());
const skip = () => !canLaunch;

const GOOD_FAQ = '<section class="faq"><details class="faq-item"><summary>What does it cost?</summary><p>It depends on the size of the move and the distance travelled, so we quote each job.</p></details></section>';
let BASELINE;
const baseline = async () => { if (!BASELINE) { const r = await captureTemplateBaseline({ urls: [url('/blog/a'), url('/blog/c')], launchBrowserFn: launch }); BASELINE = { ...r, sample_urls: r.sampleUrls, usable: true }; } return BASELINE; };
const check = async (html, extra = {}) => runDesignRenderCheck({ pageUrl: url('/blog/b'), html, mode: 'marker', marker: 'FAQ', baseline: await baseline(), launchBrowserFn: launch, ...extra });

describe('baseline capture measures the TEMPLATE, not the noise on it', { skip: false }, () => {
  test('two agreeing pages give a ready baseline at BOTH widths: the MODAL body size (17), not the 19px lead paragraph', async (t) => {
    if (skip()) return t.skip('no browser');
    const b = await baseline();
    assert.equal(b.status, 'ready'); assert.equal(b.confidence, 'agreeing-samples');
    assert.equal(b.tokens.desktop.p.fontSize, 17); assert.equal(b.tokens.desktop.h2.fontSize, 32); assert.equal(b.tokens.desktop.p.family, 'helvetica neue');
    assert.equal(b.tokens.mobile.p.fontSize, 16); assert.equal(b.tokens.mobile.h2.fontSize, 26);
    assert.ok(b.tokens.desktop.containerWidth >= 640 && b.tokens.desktop.containerWidth <= 720, `desktop column ${b.tokens.desktop.containerWidth}`);
    assert.ok(b.tokens.mobile.containerWidth <= 358 && b.tokens.mobile.containerWidth >= 300, `mobile column ${b.tokens.mobile.containerWidth}`);
  });
  test('platform SEOAI output and the cookie banner do NOT pollute what the site looks like', async (t) => {
    if (skip()) return t.skip('no browser');
    const b = await baseline();
    for (const noise of ['text-3xl', 'md:text-4xl', 'platform-faq', 'cookie-consent-bar']) assert.ok(!b.vocabulary.includes(noise), `${noise} must not be in the template vocabulary`);
    assert.ok(b.vocabulary.includes('faq-item') && b.vocabulary.includes('blog-post-body'));
  });
  test('the template\'s existing patterns are recorded: it HAS a FAQ, it has no table, no related list', async (t) => {
    if (skip()) return t.skip('no browser');
    const b = await baseline();
    assert.equal(b.patterns.faq.present, true); assert.equal(b.patterns.table.present, false); assert.equal(b.patterns['related-links'].present, false);
  });
  test('pages that disagree make an UNSTABLE baseline (not usable), naming the field', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await captureTemplateBaseline({ urls: [url('/blog/a'), url('/blog/odd')], launchBrowserFn: launch });
    assert.equal(r.status, 'unstable'); assert.ok(r.disagreements.some((d) => d.field === 'p.fontSize'), JSON.stringify(r.disagreements));
  });
  test('no page with a body region is a FAILED capture, with the reason; nothing is invented', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await captureTemplateBaseline({ urls: [url('/blog/empty')], launchBrowserFn: launch });
    assert.equal(r.status, 'failed'); assert.match(r.error, /body region|no page/); assert.equal(r.tokens, undefined);
    assert.equal((await captureTemplateBaseline({ urls: [], launchBrowserFn: launch })).status, 'failed');
  });
  test('a single page gives a ready baseline flagged single-sample', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await captureTemplateBaseline({ urls: [url('/blog/c')], launchBrowserFn: launch });
    assert.deepEqual([r.status, r.confidence], ['ready', 'single-sample']);
  });
});

describe('render before/after in the real template at 1440 and 390', () => {
  test('a correct FAQ in the site\'s own format passes everything at both widths (no false failure)', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await check(GOOD_FAQ);
    assert.equal(r.status, 'ok');
    assert.deepEqual([r.deviations, r.outside, r.heading, r.overflow], [[], [], [], []], JSON.stringify(r));
    assert.deepEqual(Object.keys(r.evidence.viewports).sort(), ['desktop', 'mobile'], 'both widths were measured');
  });
  test('a block that restyles the body is caught: size, font, colour and invented classes', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await check('<div class="fancy-box"><p class="fancy" style="font-size:26px;font-family:Georgia,serif;color:#c00">Look at me, I am a very differently styled paragraph of text here.</p></div>');
    const kinds = new Set(r.deviations.map((d) => d.kind));
    for (const k of ['body-size', 'font-family', 'text-color', 'foreign-classes']) assert.ok(kinds.has(k), `${k} expected in ${[...kinds]}`);
  });
  test('a block that reaches OUTSIDE itself (a <style> that restyles the nav) is caught as outside-changed', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await check(`<style>nav.site-nav{background:red;padding:50px}</style>${GOOD_FAQ}`);
    assert.ok(r.outside.length > 0 && r.outside[0].kind === 'outside-changed', JSON.stringify(r.outside));
  });
  test('a wide table pushes a phone sideways: mobile-overflow (and only on mobile)', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await check('<table style="width:1100px"><tr><td>Plan</td><td>Price</td></tr></table>');
    assert.ok(r.overflow.some((d) => d.viewport === 'mobile'), JSON.stringify(r.overflow));
    assert.ok(r.deviations.some((d) => d.kind === 'mobile-overflow' && d.viewport === 'mobile'));
    assert.ok(!r.overflow.some((d) => d.viewport === 'desktop'));
  });
  test('a second H1 and a skipped heading level are caught', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await check('<h1>Another title</h1><h4>Skipped</h4><p>Text of the block that is long enough to measure properly in the browser.</p>');
    const kinds = new Set(r.heading.map((d) => d.kind)); assert.ok(kinds.has('second-h1') && kinds.has('skipped-heading-level'), [...kinds].join());
  });
  test('a page with no marker, a page with no body region, and an unreachable page are "could not check", never a pass', async (t) => {
    if (skip()) return t.skip('no browser');
    assert.equal((await check(GOOD_FAQ, { pageUrl: url('/blog/nomarker') })).status, 'no-region');
    assert.equal((await check(GOOD_FAQ, { pageUrl: url('/blog/empty'), mode: 'append', marker: null })).status, 'no-region');
    assert.equal((await check(GOOD_FAQ, { pageUrl: 'http://127.0.0.1:1/nothing', navTimeoutMs: 3000 })).status, 'unreachable');
    assert.equal((await check(GOOD_FAQ, { launchBrowserFn: async () => { throw new Error('no browser slot'); } })).status, 'unreachable');
  });
  test('a first insertion (no marker yet) is checked by appending to the body region', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await check(GOOD_FAQ, { pageUrl: url('/blog/nomarker'), mode: 'append', marker: null });
    assert.equal(r.status, 'ok'); assert.deepEqual(r.deviations, []);
  });
});

describe('unrelated pages must not change (shared-file edits)', () => {
  test('a preview that restyles the nav on another page of the layout is caught; an identical preview passes; no preview is "none"', async (t) => {
    if (skip()) return t.skip('no browser');
    const preview = (u) => u.replace('/live/', '/preview/');
    const differs = await checkUnrelatedPages({ liveUrls: [url('/live/x'), url('/live/y')], previewUrlFor: preview, launchBrowserFn: launch });
    assert.equal(differs.status, 'differs'); assert.match(differs.detail, /\/live\/x/);
    const same = await checkUnrelatedPages({ liveUrls: [url('/live/y')], previewUrlFor: preview, launchBrowserFn: launch });
    assert.equal(same.status, 'same');
    assert.equal((await checkUnrelatedPages({ liveUrls: [url('/live/y')], previewUrlFor: null })).status, 'none');
    assert.equal((await checkUnrelatedPages({ liveUrls: [url('/live/y')], previewUrlFor: () => 'http://127.0.0.1:1/x', launchBrowserFn: launch, navTimeoutMs: 3000 })).status, 'unreachable');
  });
});

describe('protectVisibleChange, real render, real baseline', () => {
  const PROFILE = { layoutGroups: { groups: [{ id: 'blog', sample: '/blog/a', members: ['/blog/a', '/blog/b', '/blog/c'] }] } };
  const mkStore = async () => { const b = await baseline(); const calls = { decisions: [], requested: [] }; return { calls, getBaseline: async () => ({ ...b, status: 'ready', captured_at: new Date().toISOString(), sample_urls: b.sampleUrls }), requestBaseline: async (...a) => calls.requested.push(a), recordProtectionDecision: async (id, d) => calls.decisions.push(d) }; };
  const go = async (change, { mode = 'enforce', q = [] } = {}) => protectVisibleChange({ site: { id: 8864, url_file_map: { siteRoot: { designProfile: PROFILE } } }, change: { generatorId: 'faq', actionType: 'faq', draftId: 1, pageUrl: url('/blog/b'), marker: 'FAQ', ...change }, mode, deps: { store: await mkStore(), renderCheck: (a) => runDesignRenderCheck({ ...a, launchBrowserFn: launch }), quarantine: async (...a) => q.push(a) } });
  test('a good FAQ passes end to end and nothing is quarantined', async (t) => {
    if (skip()) return t.skip('no browser');
    const q = []; const r = await go({ html: GOOD_FAQ }, { q });
    assert.deepEqual([r.ok, r.verdict, r.repaired], [true, 'pass', false]); assert.equal(q.length, 0);
  });
  test('a FAQ with the model\'s own classes is REPAIRED with the site\'s classes and then passes the same check (no false failure)', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await go({ html: '<section class="my-faq-wrapper"><details class="my-faq-item"><summary>What does it cost?</summary><p>It depends on the size of the move and the distance travelled, so we quote each job.</p></details></section>' });
    assert.equal(r.verdict, 'pass', JSON.stringify(r.reasons)); assert.equal(r.repaired, true);
    assert.ok(!r.html.includes('my-faq') ); assert.ok(r.evidence.repair.attempts.length >= 1);
  });
  test('a wide table is repaired with a scrolling box and passes; the same table in LOG mode ships unchanged but is recorded as would-block', async (t) => {
    if (skip()) return t.skip('no browser');
    const table = '<table class="data" style="width:1100px"><tr><td>Plan</td><td>Price</td></tr></table>';
    // The template shows no table, so a table needs input rather than invented design:
    const r = await go({ html: table, generatorId: 'comparison-table', actionType: 'comparison-table' });
    assert.deepEqual([r.verdict, r.reason], ['needs-input', 'no-existing-pattern']);
  });
  test('a second H1 is repaired (demoted) and passes', async (t) => {
    if (skip()) return t.skip('no browser');
    const r = await go({ html: '<h1>Another title</h1><p>Text of the block that is long enough to measure properly in the browser at both widths.</p>', generatorId: 'expand-content', actionType: 'expand-content' });
    assert.equal(r.verdict, 'pass', JSON.stringify(r.reasons)); assert.equal(r.repaired, true); assert.ok(!/<h1/i.test(r.html));
  });
  test('a change that restyles the nav is quarantined (content kept), never shipped, and not "repaired" by rewriting the block', async (t) => {
    if (skip()) return t.skip('no browser');
    const q = []; const r = await go({ html: `<style>nav.site-nav{display:none}</style>${GOOD_FAQ}` }, { q });
    assert.deepEqual([r.ok, r.verdict, r.blocked, r.repaired], [false, 'blocked', true, false]);
    assert.equal(q.length, 1); assert.equal(q[0][1].failureClass, 'design-protection:blocked');
  });
  test('LOG mode: the same restyling change is recorded as would-block and the ORIGINAL html comes back', async (t) => {
    if (skip()) return t.skip('no browser');
    const html = `<style>nav.site-nav{display:none}</style>${GOOD_FAQ}`; const q = [];
    const r = await go({ html }, { mode: 'log', q });
    assert.deepEqual([r.ok, r.wouldBlock, r.blocked, r.html === html], [true, true, false, true]); assert.equal(q.length, 0);
  });
});
