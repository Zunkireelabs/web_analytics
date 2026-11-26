// Real-browser regression tests for WHICH headings count as a page's design evidence (zennly.io, 2026-11): a navigation mega-menu panel's <h4 class="v2-mm__aside-title">
// was recorded as the article's "subheading" class, while the article's real headings are bare <h2>/<h3> styled by the layout. Skipped (not failed) when no browser can launch.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { launchBrowser, captureLoadedPage } from './capture.js';
import { segmentSite } from './segment.js';
import { backfillPageTypePatterns, correctPageTypeTextHierarchy, articleBodyEvidence } from './profile-extract.js';

const ZENNLY = fs.readFileSync(new URL('./fixtures/zennly-article-trimmed.html', import.meta.url), 'utf8');
const LONG = 'A representative paragraph of article copy that is comfortably longer than forty characters so it counts as real body text for the region finder. ';

// ANOTHER client's shape: its body headings DO carry a class, it has its own dropdown panel with a heading, and it has a genuine CONTENT section called "menu"
// (a restaurant's menu), which must never be mistaken for navigation.
const CLASSED = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px/1.5 sans-serif}.dropdown-panel{height:160px}.menu-section{padding:30px}.post{max-width:700px;margin:0 auto}</style></head>
<body><header class="site-header"><a href="/">brand</a></header>
<div class="dropdown-panel"><h4 class="menu-heading">Browse all services</h4><p>${LONG}</p></div>
<main><section class="menu-section"><h2 class="menu-section__title">Our menu</h2><p>${LONG}</p></section>
<article class="post"><h1>Title of the article</h1><p>${LONG}</p><h2 class="post-h2">First part</h2><p>${LONG}</p><p>${LONG}</p><h2 class="post-h2">Second part</h2><p>${LONG}</p><p>${LONG}</p><h3 class="post-h3">A detail</h3><p>${LONG}</p></article></main>
<footer><p>${LONG}</p></footer></body></html>`;

let browser = null; let skip = false;
async function capture(html, pageType = 'blog-article') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  const captured = await captureLoadedPage(page, 'https://x.test/blog/post/');
  await ctx.close();
  return { captured, seg: segmentSite({ pages: [{ ...captured, pageType }] }) };
}

describe('heading evidence: the page body counts, navigation never does', () => {
  before(async () => { try { browser = await launchBrowser(); } catch { skip = true; } });
  after(async () => { if (browser) await browser.close().catch(() => {}); });

  test('Zennly: the mega-menu panel (a top-level sibling of <header>) is chrome, and its <h4> is not evidence', async (t) => {
    if (skip) return t.skip('no browser');
    const { captured, seg } = await capture(ZENNLY);
    const mega = captured.blocks.find((b) => /v2-mm/.test(b.classes || ''));
    assert.ok(mega, 'the panel was captured as a block'); assert.match(mega.chrome || '', /name:mega/, 'and flagged as furniture');
    assert.equal(seg[0].sections.find((s) => /v2-mm/.test(s.classes || '')).role, 'nav', 'segmented as navigation, never as content');
  });

  test('Zennly: the article body headings are captured from the body region only, and they are bare', async (t) => {
    if (skip) return t.skip('no browser');
    const { captured } = await capture(ZENNLY);
    assert.equal(captured.bodyRegionFound, true);
    assert.deepEqual(captured.bodyHeadings.map((h) => [h.level, h.classes]), [[2, ''], [2, ''], [3, ''], [2, '']], 'h2/h3 inside .article-body, no classes');
    assert.ok(!captured.bodyHeadings.some((h) => /Keep reading|Losing enquiries/.test(h.text)), 'the sidebar card and the "Keep reading" block are not the article body');
  });

  test('Zennly: the recorded article subheading is BARE and is never v2-mm__aside-title', async (t) => {
    if (skip) return t.skip('no browser');
    const { seg } = await capture(ZENNLY);
    const filled = backfillPageTypePatterns({}, seg).pageTypePatterns['blog-article'];
    const entry = filled.textHierarchy.find((e) => e.role === 'subheading');
    assert.deepEqual([entry.classes, entry.bare, entry.observedInBody, entry.observed], [null, true, true, 4]);
    assert.ok(!JSON.stringify(filled).includes('v2-mm__aside-title'));
    // the old failure mode: a model/backfill summary that already carries the menu class is corrected to bare, never kept and never replaced by another class
    const corrected = correctPageTypeTextHierarchy({ 'blog-article': { sectionOrder: [], textHierarchy: [{ role: 'subheading', classes: 'v2-mm__aside-title', styleNotes: 'Observed on the captured sample page.' }] } }, seg);
    const fixed = corrected.pageTypePatterns['blog-article'].textHierarchy.find((e) => e.role === 'subheading');
    assert.deepEqual([fixed.classes, fixed.bare], [null, true]); assert.deepEqual(corrected.corrected, ['blog-article']);
    assert.ok(!JSON.stringify(corrected.pageTypePatterns).includes('v2-mm__aside-title'));
  });

  test('another client whose body headings DO carry a class still records that class (nothing changes for it)', async (t) => {
    if (skip) return t.skip('no browser');
    const { captured, seg } = await capture(CLASSED);
    assert.deepEqual(captured.bodyHeadings.map((h) => h.classes), ['post-h2', 'post-h2', 'post-h3']);
    const ev = articleBodyEvidence(seg).get('blog-article'); assert.deepEqual([ev.observed, ev.classed], [3, 3]);
    const entry = backfillPageTypePatterns({}, seg).pageTypePatterns['blog-article'].textHierarchy.find((e) => e.role === 'subheading');
    assert.equal(entry.bare, false); assert.equal(entry.observedInBody, true); assert.match(entry.classes, /^post-h[23]$|post-h2/);
    // a wrong class in the model summary is replaced by the one the body really uses
    const fixed = correctPageTypeTextHierarchy({ 'blog-article': { textHierarchy: [{ role: 'subheading', classes: 'menu-heading' }] } }, seg).pageTypePatterns['blog-article'].textHierarchy.find((e) => e.role === 'subheading');
    assert.match(fixed.classes, /post-h/);
  });

  test('chrome is narrow: a dropdown panel is furniture, but a real content section named "menu" stays content', async (t) => {
    if (skip) return t.skip('no browser');
    const { captured } = await capture(CLASSED);
    assert.match(captured.blocks.find((b) => /dropdown-panel/.test(b.classes || '')).chrome || '', /name:dropdown/);
    assert.equal(captured.blocks.find((b) => /menu-section/.test(b.classes || '')).chrome, null, 'a "menu" token alone is never enough');
  });

  test('a page with no article body region records no body headings, and the older section-based evidence is untouched', async (t) => {
    if (skip) return t.skip('no browser');
    const { captured, seg } = await capture('<!doctype html><body><header>nav</header><section><h2 class="big">Hi</h2></section></body>', 'service');
    assert.deepEqual(captured.bodyHeadings, []);
    assert.equal(articleBodyEvidence(seg).size, 0);
  });
});
