// Real-browser regression tests for the body-region measurement and injection
// the new-page render gate depends on (newpage-render-gate.js). Every fixture is
// a small, self-contained "client site" with a DIFFERENT way of scoping its
// typography — the point of the suite is that the gate must judge a draft by
// where the site's own template would place it, and never fail a correct draft
// because the gate swapped out a wrapper the site's CSS hangs on.
//
// Skipped (not failed) when no browser can launch, the same posture as every
// other live-render check in this pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from './capture.js';
import { checkNewPageRender } from '../../generators/lib/newpage-render-gate.js';

const SENTENCE = 'This is a representative paragraph of generated body copy that is long enough to wrap across several lines so the measured line length reflects the container width and nothing else about the sentence. ';
const P = (n = 2) => `<p>${SENTENCE.repeat(n)}</p>`;
const BARE_BODY = `<h2>A section heading</h2>${P()}${P()}<h3>A subheading</h3>${P()}${P()}`;
const dataUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

// Three sites that scope body typography three different ways.
const SITES = {
  // Rules hang on wrappers INSIDE <main> (the Mobilise shape): the page has a
  // header standfirst, then .blog-content holds the prose.
  'wrapper-scoped (article > .blog-content)': `<!doctype html><style>
    body{font:16px/1.4 sans-serif;margin:0}
    .blog-article{margin-left:200px;padding-left:115px;width:1040px;box-sizing:border-box}
    .blog-article .blog-header p{max-width:720px;margin:28px 0 16px;font-size:20px}
    .blog-article .blog-content{max-width:720px}
    .blog-article .blog-content p{font-size:20px;line-height:1.6;margin:0 0 26px}
    .blog-article .blog-content h2{font-size:42px;line-height:1.15;margin:48px 0 18px}
    .blog-article .blog-content h3{font-size:24px;margin:12px 0}
    @media(max-width:600px){.blog-article{margin:0;padding:0 16px;width:auto}}
  </style><body><main class="blog-page"><article class="blog-article">
    <header class="blog-header"><h1>Title</h1>${P(1)}</header>
    <div class="blog-content"><h2>Existing heading</h2>${P()}${P()}${P()}<h3>Sub</h3>${P()}${P()}</div></article>
    <section class="other-blogs"><p>Short card text for another post.</p></section></main></body>`,

  // A typography plugin class on one container.
  'prose plugin (.prose)': `<!doctype html><style>
    body{font:16px/1.4 sans-serif;margin:0}
    .prose{max-width:680px;margin:0 auto;font-size:18px;line-height:1.7}
    .prose p{margin:0 0 22px}.prose h2{font-size:36px;margin:40px 0 16px}.prose h3{font-size:22px}
  </style><body><main><div class="prose"><h2>Existing</h2>${P()}${P()}${P()}<h3>Sub</h3>${P()}${P()}</div></main></body>`,

  // Body directly under <article>, no inner wrapper at all.
  'flat article': `<!doctype html><style>
    body{font:17px/1.6 sans-serif;margin:0}
    article{max-width:700px;margin:0 auto}article p{margin:0 0 20px}article h2{font-size:32px;margin:36px 0 14px}article h3{font-size:22px}
  </style><body><article><h2>Existing</h2>${P()}${P()}${P()}<h3>Sub</h3>${P()}${P()}</article></body>`,
};

async function browserOrSkip(t) {
  try { const b = await launchBrowser(); await b.close(); return true; } catch { t.skip('no browser available'); return false; }
}

for (const [name, html] of Object.entries(SITES)) {
  test(`a correct bare body is NOT a deviation on a ${name} site`, async (t) => {
    if (!(await browserOrSkip(t))) return;
    const r = await checkNewPageRender({ referenceUrl: dataUrl(html), newPageHtml: BARE_BODY });
    assert.equal(r.ok, true);
    assert.equal(r.broken, false, `unexpected deviations: ${JSON.stringify(r.deviations)}`);
  });
}

test('control: the site\'s OWN body put back through the gate is never a deviation', async (t) => {
  if (!(await browserOrSkip(t))) return;
  for (const html of Object.values(SITES)) {
    const own = `<h2>Existing heading</h2>${P()}${P()}${P()}<h3>Sub</h3>${P()}${P()}`;
    const r = await checkNewPageRender({ referenceUrl: dataUrl(html), newPageHtml: own });
    assert.equal(r.broken, false, JSON.stringify(r.deviations));
  }
});

test('control: the gate still catches a draft that really is off-design (oversized inline heading)', async (t) => {
  if (!(await browserOrSkip(t))) return;
  const bad = `<h2 style="font-size:72px">Wrong scale</h2>${P()}${P()}${P()}`;
  const r = await checkNewPageRender({ referenceUrl: dataUrl(SITES['wrapper-scoped (article > .blog-content)']), newPageHtml: bad });
  assert.equal(r.broken, true);
  assert.ok(r.deviations.some((d) => d.kind === 'heading-scale'), JSON.stringify(r.deviations));
});

test('control: the gate still catches body text sized differently from the site', async (t) => {
  if (!(await browserOrSkip(t))) return;
  const bad = `<h2>Heading</h2>${`<p style="font-size:30px">${SENTENCE.repeat(2)}</p>`.repeat(4)}`;
  const r = await checkNewPageRender({ referenceUrl: dataUrl(SITES['flat article']), newPageHtml: bad });
  assert.equal(r.broken, true);
  assert.ok(r.deviations.some((d) => d.kind === 'body-size'), JSON.stringify(r.deviations));
});

test('a lone header standfirst is not mistaken for the body when measuring paragraph gaps', async (t) => {
  if (!(await browserOrSkip(t))) return;
  const html = SITES['wrapper-scoped (article > .blog-content)'];
  const r = await checkNewPageRender({ referenceUrl: dataUrl(html), newPageHtml: BARE_BODY });
  assert.ok(!(r.deviations || []).some((d) => d.kind === 'paragraph-gap'), JSON.stringify(r.deviations));
});

// A <main> that holds a hero, the article AND an FAQ (so no single child holds 80% of main's text), whose renderer styles every element with its own
// class + inline style (no scoped CSS). Before the fix the body region was <main>: injecting wiped the hero/title/container and left bare, unstyled tags.
test('main with hero + article + FAQ: the draft goes into the article only, wearing the site\'s own per-element styles', async (t) => {
  let b; try { b = await launchBrowser(); } catch { t.skip('no browser available'); return; }
  try {
    const { renderArticlePreview } = await import('../../generators/lib/article-preview.js');
    const faq = Array.from({ length: 2 }, () => P(1)).join('');
    const html = `<!doctype html><body style="margin:0"><header><h1>Original title</h1></header><main>
      <section id="hero"><p>${SENTENCE}</p></section>
      <article><div class="wrap"><div class="body">
        <div><h2 class="x" style="font-size:30px;font-weight:700">Real heading</h2><p class="q" style="font-size:17px;line-height:1.85">${SENTENCE.repeat(3)}</p><p class="q" style="font-size:17px;line-height:1.85">${SENTENCE.repeat(3)}</p></div>
        <div><h2 class="x" style="font-size:30px;font-weight:700">Another</h2><p class="q" style="font-size:17px;line-height:1.85">${SENTENCE.repeat(3)}</p></div>
      </div></div></article>
      <section id="faq">${faq}</section></main><footer id="foot">footer</footer></body>`;
    const r = await renderArticlePreview({ referenceUrl: dataUrl(html), bodyHtml: '<h2>Draft heading</h2><p>Draft text.</p>', title: 'Draft title', fullPage: false });
    assert.equal(r.ok, true);
    assert.ok(!r.skip);
    assert.ok(r.replaced.classesCopied.includes('h2') && r.replaced.classesCopied.includes('p'));
    // The same render again, inspected: hero + FAQ + footer survive, the h2 wears the site's size.
    const page = await (await b.newContext()).newPage();
    await page.goto(dataUrl(html));
    const { measureBodyInPage } = await import('./body-measure.js');
    await page.evaluate(measureBodyInPage, true);
    const region = await page.evaluate(() => { const e = document.querySelector('[data-gate-region]'); return { tag: e.tagName, hasHero: !!e.querySelector('#hero'), hasFaq: !!e.querySelector('#faq'), cls: e.className }; });
    assert.notEqual(region.tag, 'MAIN');
    assert.equal(region.hasHero, false);
    assert.equal(region.hasFaq, false);
    assert.equal(r.deviations.length, 0, JSON.stringify(r.deviations));
  } finally { await b.close(); }
});

// chayceproperties.com: its article body sits in plain wrappers (no article, main, prose, post-content). The detector found nothing, so every preview and
// length check silently did nothing for that site. The element that directly holds the paragraphs is the body.
test('plain-wrapper article (no article/main/prose): the element holding the paragraphs is found as the body region', async (t) => {
  let browser;
  try { browser = await launchBrowser(); } catch { t.skip('no browser'); return; }
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const html = `<!doctype html><body><div class="site-header"><p>Short nav text.</p></div><div class="page"><div class="post-wrap"><h1>Title</h1><div class="copy"><h2>Heading</h2>${P()}${P()}${P()}<h3>Sub</h3>${P()}</div></div></div></body>`;
    await page.goto(dataUrl(html));
    const { measureBodyInPage } = await import('./body-measure.js');
    const m = await page.evaluate(measureBodyInPage, true);
    assert.equal(m.found, true);
    assert.equal(await page.evaluate(() => document.querySelector('[data-gate-region]')?.className), 'copy');
  } finally { await browser.close().catch(() => {}); }
});

// A site that styles its LEAD paragraph larger (`p:first-child`, the Chayce shape: 19px lead, 17px rest). A draft opens with a heading, so it has no lead
// paragraph. Comparing first paragraph with first paragraph reported 19 vs 17 and held ten correct drafts (2026-11-25): body text is compared by its
// most common size instead.
test('a larger lead paragraph on the site does not make a correct body look the wrong size', async (t) => {
  if (!(await browserOrSkip(t))) return;
  const html = `<!doctype html><style>
    body{font:17px/1.6 sans-serif;margin:0}
    .post{max-width:700px;margin:0 auto}.post p{margin:0 0 20px;font-size:17px}.post p:first-child{font-size:19px}
    .post h2{font-size:32px;margin:36px 0 14px}
  </style><body><main><div class="post">${P()}${P()}<h2>Existing</h2>${P()}${P()}${P()}</div></main></body>`;
  const r = await checkNewPageRender({ referenceUrl: dataUrl(html), newPageHtml: BARE_BODY });
  assert.equal(r.ok, true);
  assert.ok(!(r.deviations || []).some((d) => d.kind === 'body-size'), JSON.stringify(r.deviations));
});
