import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isHtmlBodyTarget, parseFrontMatter, emitFrontMatter, renderHtmlBody, renderNjkPost, computeOrderFileUpdate } from './njk-post.js';

// Synthetic posts in the SHAPE of an Eleventy blog whose layout builds everything from front matter (values are invented for the tests).
const raw = (over = {}) => {
  const d = {
    title: 'A guide to salon booking | Acme', h1: 'A guide to salon booking', metaDescription: 'How booking works.', datePublished: '2026-11-01', dateModified: '2026-11-01',
    category: 'Salons', categoryAnchor: 'salons', readTime: '5 min read', subtitle: 'One line.', coverImage: '/assets/images/salon.png', coverAlt: 'A salon',
    cardExcerpt: 'Card text.', sidebarCtaHeading: 'Side head', sidebarCtaBody: 'Side body', bottomCtaHeading: 'Bottom head', bottomCtaBody: 'Bottom body', ...over,
  };
  return `---
layout: layouts/blog-article.njk
title: "${d.title}" # SEOAI:TITLE
h1: "${d.h1}"
metaDescription: "${d.metaDescription}" # SEOAI:METADESCRIPTION
datePublished: "${d.datePublished}"
dateModified: "${d.dateModified}"
ogType: article
bodyClass: page--light-nav page--pink-cta
category: "${d.category}"
categoryAnchor: "${d.categoryAnchor}"
readTime: "${d.readTime}"
subtitle: "${d.subtitle}"
coverImage: "${d.coverImage}"
coverAlt: "${d.coverAlt}"
cardExcerpt: "${d.cardExcerpt}"
sidebarCtaHeading: "${d.sidebarCtaHeading}"
sidebarCtaBody: "${d.sidebarCtaBody}"
bottomCtaHeading: "${d.bottomCtaHeading}"
bottomCtaBody: "${d.bottomCtaBody}"
faq:
  - question: "What is it?"
    answer: "It is a thing."
  - question: "Why?"
    answer: "Because."
relatedReading:
  - url: "/features/booking/"
    label: "Online booking"
keepReading:
  - link: "/blog/other/"
    image: "x.png"
    tag: "Salons"
    title: "Other post"
    read: "4 min read"
    tone: 2
---
<p><strong>Answer.</strong></p>
<h2>Section</h2>
<p>Text.</p>
`;
};
const SIBS = [
  ['salon-a', { datePublished: '2026-11-18', category: 'Salons', categoryAnchor: 'salons', sidebarCtaHeading: 'Salon head', coverImage: '/assets/images/salon-new.png', coverAlt: 'New salon cover' }],
  ['salon-b', { datePublished: '2026-10-01', category: 'Salons', categoryAnchor: 'salons' }],
  ['spa-a', { datePublished: '2026-11-10', category: 'Spa & Wellness', categoryAnchor: 'spa-wellness', sidebarCtaHeading: 'Spa head', coverImage: '/assets/images/spa.png', coverAlt: 'Spa' }],
  ['ops-a', { datePublished: '2026-09-01', category: 'Operations', categoryAnchor: 'operations' }],
].map(([slug, over]) => ({ slug, ...parseFrontMatter(raw(over)) }));

describe('isHtmlBodyTarget', () => {
  test('only an .njk/.html target that is neither clone-sibling nor a TSX filename target', () => {
    assert.equal(isHtmlBodyTarget({ dir: 'a', extension: '.njk' }), true);
    assert.equal(isHtmlBodyTarget({ dir: 'a', extension: '.html' }), true);
    for (const cfg of [{ extension: '.md' }, { extension: '.tsx', filename: 'page.tsx' }, { extension: '.njk', mode: 'clone-sibling' }, { extension: '.njk', filename: 'page.tsx' }, {}, null, undefined]) assert.equal(isHtmlBodyTarget(cfg), false, JSON.stringify(cfg));
  });
});

describe('front matter reader and writer', () => {
  test('reads scalars, quoted strings with comments, lists of maps and numbers exactly', () => {
    const fm = parseFrontMatter(raw());
    assert.equal(fm.data.layout, 'layouts/blog-article.njk'); assert.equal(fm.data.title, 'A guide to salon booking | Acme'); assert.equal(fm.markers.title, 'SEOAI:TITLE');
    assert.deepEqual(fm.data.faq, [{ question: 'What is it?', answer: 'It is a thing.' }, { question: 'Why?', answer: 'Because.' }]);
    assert.equal(fm.data.keepReading[0].tone, 2); assert.deepEqual(fm.data.relatedReading, [{ url: '/features/booking/', label: 'Online booking' }]);
  });
  test('writing then reading gives the same data (quotes, colons and unicode survive)', () => {
    const data = { layout: 'layouts/blog-article.njk', title: 'He said "hi": a # test — ünï', faq: [{ question: 'Q: "x"?', answer: 'A # b' }], n: 3 };
    const back = parseFrontMatter(`${emitFrontMatter(data, { bareKeys: new Set(['layout']) })}\nbody`);
    assert.deepEqual(back.data, data);
  });
  test('anything it cannot read exactly returns null (never used as a model)', () => {
    assert.equal(parseFrontMatter('no front matter'), null);
    assert.equal(parseFrontMatter('---\n[weird]\n---\n'), null);
    assert.equal(parseFrontMatter('---\ntitle: "unterminated\n---\n'), null);
  });
});

describe('the HTML body', () => {
  test('quick answer bold first, sections as H2, markdown converted to the elements the site uses', () => {
    const r = renderHtmlBody({ quickAnswer: 'It **works**.', sections: [{ heading: 'Why it matters', body: 'Para one with a [link](https://example.com/x) and *emphasis*.\n\n- one\n- **two**\n\n1. first\n2. second\n\n### Detail\nMore.' }] });
    assert.equal(r.ok, true);
    assert.match(r.html, /^<p><strong>It works\.<\/strong><\/p>\n<h2>Why it matters<\/h2>/);
    assert.match(r.html, /<a href="https:\/\/example\.com\/x">link<\/a>/); assert.match(r.html, /<ul>\n<li>one<\/li>\n<li><strong>two<\/strong><\/li>\n<\/ul>/); assert.match(r.html, /<ol>/);
    assert.match(r.html, /<h3>Detail<\/h3>/);
  });
  test('never any markdown syntax, class, style, wrapper or H1 in the output; levels never skip', () => {
    const r = renderHtmlBody({ quickAnswer: 'A.', sections: [{ heading: 'One', body: '# Big\n\n## Mid\n\n#### Deep\n\ntext' }, { heading: 'Two', body: 'x' }] });
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.html, /<h1|<h4|<h5|class=|style=|<div|^#|\*\*/m);
    const levels = [...r.html.matchAll(/<h([1-6])/g)].map((m) => Number(m[1]));
    assert.deepEqual(levels, [2, 3, 3, 3, 2]); // h2 then h3s, no skipped level
  });
  test('Nunjucks syntax in the text can never execute: the brace is an entity', () => {
    const r = renderHtmlBody({ sections: [{ heading: 'Tags {{ x }}', body: 'Use {% raw %} and {# c #} here.' }] });
    assert.equal(r.ok, true); assert.doesNotMatch(r.html, /\{[{%#]/); assert.match(r.html, /&#123;\{ x \}\}/); assert.match(r.html, /&#123;% raw %\}/); assert.match(r.html, /&#123;# c #\}/);
  });
  test('raw HTML and script in the draft are shown as text, not written as markup', () => {
    const r = renderHtmlBody({ sections: [{ heading: 'H', body: 'a <script>alert(1)</script> b <div class="x">y</div>' }] });
    assert.equal(r.ok, true); assert.doesNotMatch(r.html, /<script|<div/); assert.match(r.html, /&lt;script&gt;/);
  });
  test('a table, an image, a code block or a quotation is flagged for review, not written', () => {
    for (const body of ['| a | b |\n|---|---|\n| 1 | 2 |', '![x](https://e.com/i.png)', '```\ncode\n```', '> quote']) {
      const r = renderHtmlBody({ sections: [{ heading: 'H', body }] });
      assert.equal(r.ok, false, body); assert.equal(r.reason, 'draft-not-ready'); assert.match(r.error, /None of them use|none of them use/i);
    }
  });
  test('a link with an unsupported address is flagged', () => {
    assert.equal(renderHtmlBody({ sections: [{ heading: 'H', body: '[x](javascript:alert(1))' }] }).ok, false);
  });
});

describe('the post, in the site\'s own format', () => {
  const content = { title: 'How booking software helps a salon', quickAnswer: 'Booking software cuts no-shows. It also frees staff time and keeps one calendar.', metaDescription: 'How booking software helps a salon.', faqItems: [{ question: 'Does it cut no-shows?', answer: 'Yes, with reminders.' }], sections: [{ heading: 'No-shows', body: 'Reminders help.' }], category: 'Salons' };
  const today = new Date('2026-11-26T08:00:00Z');
  const render = (c = content, posts = SIBS) => renderNjkPost(c, {}, { posts, today });

  test('declares exactly the keys every sibling post declares, in the siblings\' order, with the shared constants', () => {
    const r = render(); assert.equal(r.ok, true);
    const fm = parseFrontMatter(r.body);
    assert.deepEqual(Object.keys(fm.data), SIBS[0].order);
    assert.equal(fm.data.layout, 'layouts/blog-article.njk'); assert.equal(fm.data.ogType, 'article'); assert.equal(fm.data.bodyClass, 'page--light-nav page--pink-cta');
    assert.match(r.body, /^layout: layouts\/blog-article\.njk$/m); assert.match(r.body, /^ogType: article$/m); // bare, like the siblings
  });
  test('derived values come from the draft; the title keeps the site\'s own brand suffix and SEOAI markers', () => {
    const fm = parseFrontMatter(render().body);
    assert.equal(fm.data.h1, 'How booking software helps a salon'); assert.equal(fm.data.title, 'How booking software helps a salon | Acme');
    assert.equal(fm.markers.title, 'SEOAI:TITLE'); assert.equal(fm.markers.metaDescription, 'SEOAI:METADESCRIPTION');
    assert.equal(fm.data.datePublished, '2026-11-26'); assert.equal(fm.data.dateModified, '2026-11-26');
    assert.equal(fm.data.subtitle, 'Booking software cuts no-shows.'); assert.match(fm.data.readTime, /^\d+ min read$/);
    assert.deepEqual(fm.data.faq, [{ question: 'Does it cut no-shows?', answer: 'Yes, with reminders.' }]);
  });
  test('category, cover, calls to action, related and keep-reading are the SAME-CATEGORY post\'s own (most recent), never invented', () => {
    const fm = parseFrontMatter(render().body);
    assert.equal(fm.data.category, 'Salons'); assert.equal(fm.data.categoryAnchor, 'salons');
    assert.equal(fm.data.sidebarCtaHeading, 'Salon head'); assert.equal(fm.data.coverImage, '/assets/images/salon-new.png'); assert.equal(fm.data.coverAlt, 'New salon cover');
    assert.deepEqual(fm.data.keepReading, SIBS[0].data.keepReading); assert.deepEqual(fm.data.relatedReading, SIBS[0].data.relatedReading);
  });
  test('the body is HTML under the front matter: no markdown, no H1', () => {
    const body = render().body.replace(/^---[\s\S]*?\n---\n/, '');
    assert.match(body, /^<p><strong>Booking software cuts no-shows/); assert.doesNotMatch(body, /^#|\*\*|<h1/m);
  });
  test('a category the human names must already exist; a new one is never created', () => {
    const r = render({ ...content, category: 'Brand new' }); assert.equal(r.ok, false); assert.equal(r.reason, 'draft-not-ready'); assert.match(r.error, /not one of this site's existing blog categories/);
  });
  test('no category given: a unique match with the site\'s own categories is used; ambiguity or no match is flagged', () => {
    const { category, ...rest } = content;
    assert.equal(render({ ...rest, title: 'Salon software for owners' }).category, 'Salons');
    const amb = render({ ...rest, title: 'Salon and spa software' }); assert.equal(amb.ok, false); assert.match(amb.error, /exactly one/);
    const none = render({ ...rest, title: 'Something unrelated entirely', topic: 'zzz' }); assert.equal(none.ok, false);
  });
  test('a cover the human names must already be an image the site\'s posts use', () => {
    assert.equal(render({ ...content, coverImage: '/assets/images/made-up.png' }).ok, false);
    assert.equal(parseFrontMatter(render({ ...content, coverImage: '/assets/images/spa.png' }).body).data.coverImage, '/assets/images/spa.png');
  });
  test('a draft with no FAQ is flagged when every sibling carries one (a person supplies it)', () => {
    const r = render({ ...content, faqItems: [] }); assert.equal(r.ok, false); assert.match(r.error, /FAQ/);
  });
  test('a key every sibling declares but the platform has no source for is named, not guessed', () => {
    const odd = SIBS.map((p) => ({ ...p, data: { ...p.data, authorBio: `bio of ${p.slug}` }, order: [...p.order, 'authorBio'] }));
    const r = render(content, odd); assert.equal(r.ok, false); assert.match(r.error, /"authorBio"/);
  });
  test('a value every sibling shares (the same for all) is a constant and is copied', () => {
    const shared = SIBS.map((p) => ({ ...p, data: { ...p.data, region: 'NP' }, order: [...p.order, 'region'] }));
    assert.equal(parseFrontMatter(render(content, shared).body).data.region, 'NP');
  });
  test('no readable sibling post: nothing is written', () => assert.equal(render(content, []).ok, false));
  test('an unsupported element in the draft is flagged for review', () => assert.equal(render({ ...content, sections: [{ heading: 'T', body: '| a |\n|---|\n| b |' }] }).ok, false));
});

describe('the post index file (orderFile)', () => {
  const site = (of) => ({ url_file_map: { newContentTargets: { 'blog-outline': { dir: 'x', extension: '.njk', ...(of ? { orderFile: of } : {}) } } } });
  const file = '[\n "b",\n "c"\n]\n';
  const fetch = (content) => async () => (content == null ? null : { content });

  test('not configured: nothing to do, so no other tenant is affected', async () => assert.equal(await computeOrderFileUpdate(site(null), 'a', fetch(file), 'main'), null));
  test('top (the default) and bottom, keeping the file\'s own formatting', async () => {
    const top = await computeOrderFileUpdate(site({ path: 'o.json' }), 'a', fetch(file), 'main');
    assert.equal(top.newContent, '[\n "a",\n "b",\n "c"\n]\n'); assert.deepEqual(JSON.parse(top.newContent), ['a', 'b', 'c']);
    const bottom = await computeOrderFileUpdate(site({ path: 'o.json', position: 'bottom' }), 'a', fetch(file), 'main');
    assert.equal(bottom.newContent, '[\n "b",\n "c",\n "a"\n]\n');
  });
  test('idempotent: a slug already listed changes nothing', async () => {
    const r = await computeOrderFileUpdate(site({ path: 'o.json' }), 'b', fetch(file), 'main'); assert.equal(r.unchanged, true); assert.equal(r.newContent, file);
  });
  test('an empty list works', async () => assert.deepEqual(JSON.parse((await computeOrderFileUpdate(site({ path: 'o.json' }), 'a', fetch('[]\n'), 'main')).newContent), ['a']));
  test('a missing, invalid or non-slug-list file is refused, never created or guessed', async () => {
    for (const c of [null, 'not json', '{"a":1}', '[1,2]']) { const r = await computeOrderFileUpdate(site({ path: 'o.json' }), 'a', fetch(c), 'main'); assert.equal(r.ok, false, String(c)); assert.equal(r.reason, 'invalid-edit'); }
  });
});
