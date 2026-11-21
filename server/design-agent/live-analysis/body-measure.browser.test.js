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
