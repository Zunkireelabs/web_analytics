import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractRelatedGuidesCard, renderRelatedGuides, tokenRelatedGuides } from './related-guides-card.js';

// Shapes copied from real client pages (shortened): a Tailwind card grid, Bootstrap news cards with a date and a second "Read more" link, and a footer link column.
const tailwind = `<main><article>Body</article><section class="py-14"><div class="max-w-7xl"><h2 class="font-bold">Related Articles</h2><p>Explore more articles.</p>
<div class="grid grid-cols-3 gap-6">
${[1, 2, 3].map((n) => `<a class="group bg-white rounded-2xl border flex flex-col" href="/post-${n}"><div class="aspect"><img src="/img/${n}.webp" srcset="a 1x" loading="lazy" alt="x" class="w-full"/></div><div class="p-5"><div class="flex gap-1.5"><span class="text-[11px] rounded-full">Study Abroad</span><span class="text-[11px] rounded-full">Nepal</span></div><h3 class="text-lg">Real title ${n}</h3><p class="text-sm">Real excerpt ${n}.</p></div></a>`).join('')}
</div></div></section></main><footer><div class="v2-footer-col"><h2 class="v2-footer-heading">Related reading</h2><a href="/a">A</a><a href="/b">B</a></div></footer>`;
const bootstrap = `<section class="page-section grey"><div class="container"><h3>More from Chayce</h3><div class="row">
${[1, 2, 3].map((n) => `<div class="col-md-4"><div class="news-card"><figure><img src="https://img/${n}.jpg"></figure><span>17 September 2026</span><h5><a href="/blog/p-${n}/">Real title ${n}</a></h5><p>Real excerpt ${n}.</p><a href="/blog/p-${n}/" style="color:#c8a96e">Read More</a></div></div>`).join('')}
</div></div></section>`;
const plainList = `<article><h2 id="related-guides">Related guides</h2><ul><li><a href="/a">A</a>: text</li><li><a href="/b">B</a>: text</li></ul></article>`;

describe('extractRelatedGuidesCard: the site\'s own card becomes a template', () => {
  test('a card grid: the site\'s classes are kept, the variable parts become placeholders', () => {
    const r = extractRelatedGuidesCard(tailwind);
    assert.equal(r.ok, true); assert.equal(r.heading, 'Related Articles'); assert.equal(r.cardCount, 3);
    assert.match(r.card, /class="group bg-white rounded-2xl border flex flex-col"/);
    assert.match(r.card, /href="\{\{URL\}\}"/); assert.match(r.card, /src="\{\{IMAGE\}\}"/);
    assert.match(r.card, /\{\{TITLE\}\}/); assert.match(r.card, /\{\{DESCRIPTION\}\}/);
    assert.doesNotMatch(r.card, /Real title|Real excerpt|post-1|1\.webp|srcset|loading=|Study Abroad|Nepal</, 'no article-specific content survives in the template');
    assert.match(r.section, /\{\{CARDS\}\}/); assert.doesNotMatch(r.section, /Real title/);
  });
  test('the footer\'s "Related reading" link column is chrome, never mistaken for the block', () => {
    const r = extractRelatedGuidesCard(tailwind);
    assert.equal(r.heading, 'Related Articles');
    assert.equal(extractRelatedGuidesCard('<footer><div><h2>Related reading</h2><a href="/a">A</a><a href="/b">B</a></div></footer>').ok, false);
  });
  test('EVERY link and the date are made generic (a "Read more" link and an article date must not survive)', () => {
    const r = extractRelatedGuidesCard(bootstrap);
    assert.equal(r.ok, true);
    assert.equal((r.card.match(/\{\{URL\}\}/g) || []).length, 2, 'title link and Read More link both templated');
    assert.doesNotMatch(r.card, /\/blog\/p-1|17 September|Real title|Real excerpt/);
    assert.match(r.card, /<h5><a href="\{\{URL\}\}">\{\{TITLE\}\}<\/a><\/h5>/, 'a title that is itself a link stays a link');
    assert.match(r.card, /Read More/, 'a constant label is kept');
  });
  test('a plain list, or a page with no related block, gives no card (the caller must not pretend)', () => {
    assert.equal(extractRelatedGuidesCard(plainList).ok, false);
    assert.equal(extractRelatedGuidesCard('<main><h1>Hi</h1><p>text</p></main>').reason, 'no-card-block');
    assert.equal(extractRelatedGuidesCard('').ok, false);
  });
  test('an illustrated, multi-heading card is refused as too complex, not copied wholesale', () => {
    const rich = `<section><h2>Related articles</h2><div>${[1, 2].map((n) => `<a href="/p${n}"><div class="cover"><h4>Fake UI heading ${n}</h4><span>Low</span><span>Found</span><h4>Another ${n}</h4><p>Claim your profile</p><p>Your move</p><p>Review sites</p></div><h3>Real ${n}</h3></a>`).join('')}</div></section>`;
    const r = extractRelatedGuidesCard(rich);
    assert.equal(r.ok, false); assert.equal(r.reason, 'card-too-complex');
  });
});

describe('renderRelatedGuides fills the template with real data and never leaves a hole', () => {
  const tpl = extractRelatedGuidesCard(tailwind);
  const items = [{ url: '/guides/a', title: 'Visa <costs> & fees', description: 'About "costs".', image: '/i/a.webp' }, { url: '/guides/b', title: 'No image or text' }];
  test('values are escaped and every placeholder is filled', () => {
    const out = renderRelatedGuides(tpl, items);
    assert.equal(out.ok, true); assert.doesNotMatch(out.html, /\{\{/);
    assert.match(out.html, /Visa &lt;costs&gt; &amp; fees/); assert.match(out.html, /About &quot;costs&quot;/);
    assert.match(out.html, /href="\/guides\/a"/); assert.match(out.html, /src="\/i\/a\.webp"/);
  });
  test('a card with no image or description drops just that part', () => {
    const second = renderRelatedGuides(tpl, [items[1]]).html;
    assert.doesNotMatch(second, /<img/); assert.doesNotMatch(second, /\{\{/); assert.match(second, /No image or text/);
  });
  test('no template or no usable item is a clear failure, not empty markup', () => {
    assert.equal(renderRelatedGuides(null, items).reason, 'no-template');
    assert.equal(renderRelatedGuides(tpl, [{ url: '', title: '' }, null]).reason, 'no-items');
  });
});

describe('tokenRelatedGuides: only for a site with no card, from its own colours, and always for review', () => {
  test('uses the site\'s tokens, escapes content, and is flagged needsReview', () => {
    const r = tokenRelatedGuides([{ url: '/a', title: 'T <b>', description: 'D', image: '/i.jpg' }], { text: '#111', muted: '#666', border: '#ddd', surface: '#fafafa', radius: '16px' });
    assert.equal(r.ok, true); assert.equal(r.needsReview, true);
    assert.match(r.html, /border-radius:16px/); assert.match(r.html, /color:#111/); assert.match(r.html, /T &lt;b&gt;/);
    assert.doesNotMatch(r.html, /<style/, 'inline styles only: no stylesheet is added to a client page');
  });
  test('missing tokens fall back to neutral values, and nothing renders without items', () => {
    assert.match(tokenRelatedGuides([{ url: '/a', title: 'T' }]).html, /inherit/);
    assert.equal(tokenRelatedGuides([]).ok, false);
  });
});
