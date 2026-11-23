import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildConvertedBlogPage, addListingCard, fmValue, setFmValue, balancedDivEnd, formatDate, renderParagraphs } from './converted-blog-page.js';

const ORIGIN = 'https://client.example';
// Shaped like the real pages of a converted Eleventy site: JSON-ish front matter with marker comments, a full written-out body, a per-page head file.
const REF_PAGE = `---
{
  "layout": "layouts/base.njk",
  "permalink": "/blog/old-reference-post/index.html",
  "headInclude": "heads/blog-old-reference-post-index.njk",
  "title": "Old Reference Strategy Guide | ACME", # SEOAI:TITLE
  "bodyAttributes": "",
  "documentStart": "<!DOCTYPE html>\\n<html lang=\\"en\\">\\n",
  "headBodyGap": "\\n",
  "documentEnd": "\\n</html>\\n",
  "description": "A reference description that must never leak into another post.", # SEOAI:METADESCRIPTION
  "componentBase": "../../"
}
---

    <div id="navbar-placeholder" data-rendered="true">{% include "components/nav.njk" %}</div>
    <main class="blog-page">
        <article class="blog-article">
            <header class="blog-header">
                <span class="eyebrow">Insights</span>
                <h1>The reference article headline</h1>
                <p>The reference lead sentence about something specific.</p>
                <p class="article-meta"><time datetime="2024-05-22">May 22, 2024</time> · By the ACME team</p>
            </header>
            <img class="blog-image" src="../../images/blog/b3.jpg" alt="Reference alt" width="768" height="768" fetchpriority="high" decoding="async">
            <div class="blog-content">
                <p>Reference body paragraph one.</p>
                <h2>Reference section</h2>
                <div class="inner"><p>nested</p></div>
                <section class="sources"><ol><li><a href="https://example.org">example.org</a></li></ol></section>
            </div>
        </article>
        <section class="other-blogs">
            <div class="other-grid">
                <a href="../" class="other-card"><h3>Another real post</h3></a>
            </div>
        </section>

<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->

<!-- SEOAI:INTERNALLINKS:START --><!-- SEOAI:INTERNALLINKS:END -->
</main>
    <div id="footer-placeholder">{% include "components/footer.njk" %}</div>
    <script src="../../shared-components.js"></script>
`;
const REF_HEAD = `
    <script defer src="../../analytics.js"></script>
    <title>{{ title | escape }}</title>
    <meta name="description" content="{{ description | escape }}">
    <!-- SEOAI:CANONICAL:START --><link rel="canonical" href="${ORIGIN}/blog/old-reference-post/"><!-- SEOAI:CANONICAL:END -->
    <meta property="og:type" content="article">
    <!-- SEOAI:OPENGRAPH:START -->
    <meta property="og:title" content="Old OG title">
    <meta property="og:description" content="Old OG description.">
    <meta name="twitter:title" content="Old twitter title">
    <meta name="twitter:description" content="Old twitter description.">
    <!-- SEOAI:OPENGRAPH:END -->
    <meta property="og:url" content="${ORIGIN}/blog/old-reference-post/">
    <meta property="og:image" content="${ORIGIN}/images/blog/b3.jpg">
    <meta property="og:image:alt" content="Reference alt">
    <meta property="article:published_time" content="2024-05-22">
    <meta property="article:modified_time" content="2026-08-17">
    <meta property="article:section" content="Brand Marketing">
    <meta name="twitter:image" content="${ORIGIN}/images/blog/b3.jpg">
    <link rel="stylesheet" href="../style.css">
    <script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","@id":"${ORIGIN}/blog/old-reference-post/#article","headline":"Old headline","description":"Old schema description.","image":"${ORIGIN}/images/blog/b3.jpg","datePublished":"2024-05-22","dateModified":"2026-08-17","mainEntityOfPage":{"@type":"WebPage","@id":"${ORIGIN}/blog/old-reference-post/"}},{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"${ORIGIN}/"},{"@type":"ListItem","position":2,"name":"Blog","item":"${ORIGIN}/blog/all/"},{"@type":"ListItem","position":3,"name":"Old reference breadcrumb name","item":"${ORIGIN}/blog/old-reference-post/"}]}]}
    </script>`;
const post = () => ({
  slug: 'new-supply-chain-post', title: 'How Supply Chains Learn', summary: 'A short lead for the new article.', metaDescription: 'What supply chains can learn from retail demand signals.',
  publishedAt: '2026-11-24', image: { url: '/images/blog/new.webp', alt: 'A warehouse floor' }, category: 'Operations',
  sections: [{ heading: 'Start with signals', body: 'First paragraph about <signals> & demand.\n\nSecond paragraph.' }, { heading: 'Then act', body: '- measure\n- decide' }],
});
const build = (over = {}) => buildConvertedBlogPage({ reference: { page: REF_PAGE, head: REF_HEAD }, post: { ...post(), ...over }, origin: ORIGIN, today: '2026-11-25' });

describe('buildConvertedBlogPage: a new post copied from a real sibling', () => {
  test('front matter: only the address, head file, title and description change, the markers stay', () => {
    const r = build(); assert.equal(r.ok, true);
    const fm = /^---\n([\s\S]*?)\n---/.exec(r.page)[1];
    assert.equal(fmValue(fm, 'permalink'), '/blog/new-supply-chain-post/index.html');
    assert.equal(fmValue(fm, 'headInclude'), 'heads/blog-new-supply-chain-post-index.njk');
    assert.equal(fmValue(fm, 'title'), 'How Supply Chains Learn | ACME');
    assert.equal(fmValue(fm, 'description'), 'What supply chains can learn from retail demand signals.');
    assert.match(fm, /# SEOAI:TITLE/); assert.match(fm, /# SEOAI:METADESCRIPTION/);
    assert.equal(fmValue(fm, 'layout'), 'layouts/base.njk'); assert.equal(fmValue(fm, 'componentBase'), '../../');
    assert.match(fm, /"documentStart": "<!DOCTYPE html>\\n<html lang=\\"en\\">\\n"/, 'the page\'s document structure is kept byte for byte');
    assert.equal(r.headIncludePath, 'heads/blog-new-supply-chain-post-index.njk');
  });
  test('body: the site\'s own structure is kept; header, date, image and content are the new post\'s', () => {
    const { page } = build();
    assert.match(page, /<h1>How Supply Chains Learn<\/h1>/); assert.match(page, /<p>A short lead for the new article\.<\/p>/);
    assert.match(page, /<time datetime="2026-11-24">November 24, 2026<\/time>/, 'the date is written the way the site writes it');
    assert.match(page, /<img class="blog-image" src="\.\.\/\.\.\/images\/blog\/new\.webp" alt="A warehouse floor" fetchpriority="high" decoding="async">/);
    assert.match(page, /<h2>Start with signals<\/h2>/); assert.match(page, /<p>First paragraph about &lt;signals&gt; &amp; demand\.<\/p>/); assert.match(page, /<ul><li>measure<\/li><li>decide<\/li><\/ul>/);
    assert.match(page, /<div id="navbar-placeholder"[^>]*>\{% include "components\/nav\.njk" %\}<\/div>/); assert.match(page, /\{% include "components\/footer\.njk" %\}/);
    assert.match(page, /<main class="blog-page">[\s\S]*<article class="blog-article">[\s\S]*<header class="blog-header">/);
  });
  test('the reference\'s article text is gone, including content nested inside divs; the markers, other-posts block and footer stay', () => {
    const { page } = build();
    for (const t of ['Reference body paragraph one', 'Reference section', 'nested', 'example.org', 'The reference article headline', 'reference lead sentence', 'b3.jpg', 'old-reference-post']) assert.equal(page.includes(t), false, t);
    assert.match(page, /<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->/); assert.match(page, /<!-- SEOAI:INTERNALLINKS:START -->/);
    assert.match(page, /<section class="other-blogs">[\s\S]*Another real post/);
    assert.match(page, /<script src="\.\.\/\.\.\/shared-components\.js"><\/script>\s*$/);
  });
  test('head file: every address, title, description, image, date and the article schema are the new post\'s', () => {
    const { head } = build();
    assert.match(head, /href="https:\/\/client\.example\/blog\/new-supply-chain-post\/"/); assert.match(head, /property="og:url" content="https:\/\/client\.example\/blog\/new-supply-chain-post\/"/);
    assert.match(head, /property="og:title" content="How Supply Chains Learn"/); assert.match(head, /name="twitter:title" content="How Supply Chains Learn"/);
    assert.match(head, /property="og:description" content="What supply chains can learn from retail demand signals\."/);
    assert.match(head, /property="og:image" content="https:\/\/client\.example\/images\/blog\/new\.webp"/); assert.match(head, /name="twitter:image" content="https:\/\/client\.example\/images\/blog\/new\.webp"/);
    assert.match(head, /property="article:published_time" content="2026-11-24"/); assert.match(head, /property="article:modified_time" content="2026-11-25"/); assert.match(head, /property="article:section" content="Operations"/);
    assert.match(head, /"headline":"How Supply Chains Learn"/); assert.match(head, /"datePublished":"2026-11-24"/); assert.match(head, /"dateModified":"2026-11-25"/); assert.match(head, /"@id":"https:\/\/client\.example\/blog\/new-supply-chain-post\/#article"/);
    for (const t of ['old-reference-post', 'b3.jpg', 'Old headline', 'Old OG', 'Old twitter', 'Old schema']) assert.equal(head.includes(t), false, t);
    assert.match(head, /\{\{ title \| escape \}\}/, 'the head still reads the title and description from the front matter');
    assert.match(head, /<!-- SEOAI:CANONICAL:START -->/);
  });
  test('the breadcrumb entry for the page names the NEW post, and the other entries are untouched', () => {
    const { head } = build(); const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(head)[1]);
    const crumbs = ld['@graph'].find((g) => g['@type'] === 'BreadcrumbList').itemListElement;
    assert.deepEqual(crumbs.map((c) => [c.name, c.item]), [['Home', `${ORIGIN}/`], ['Blog', `${ORIGIN}/blog/all/`], ['How Supply Chains Learn', `${ORIGIN}/blog/new-supply-chain-post/`]]);
    assert.doesNotMatch(head, /Old reference breadcrumb name/);
  });
  test('text about the reference article that the builder does not know how to replace is caught, not shipped', () => {
    const odd = REF_HEAD.replace('<link rel="stylesheet"', '<meta property="og:title" content="Old OG title" data-x="1"><meta name="twitter:title" content="Old twitter title">\n    <link rel="stylesheet"');
    assert.equal(build().ok, true);
    const r = buildConvertedBlogPage({ reference: { page: REF_PAGE, head: odd.replace('</script>', '</script><div>Old reference breadcrumb name</div>') }, post: post(), origin: ORIGIN, today: '2026-11-25' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'leftover'); assert.match(r.error, /Old reference breadcrumb name/);
  });
  test('a post with no image drops the image element AND every image tag and schema field, never keeping the reference article\'s picture', () => {
    const r = build({ image: null }); assert.equal(r.ok, true);
    assert.doesNotMatch(r.page, /blog-image/); assert.doesNotMatch(r.head, /og:image|twitter:image|b3\.jpg|"image"/);
    assert.match(r.head, /"headline":"How Supply Chains Learn"/, 'the rest of the schema is intact');
    assert.doesNotThrow(() => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(r.head)[1]), 'the schema is still valid JSON');
  });
  test('with an image the schema is still valid JSON', () => {
    const r = build(); assert.doesNotThrow(() => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(r.head)[1]));
  });
  test('a day-first date style in the reference is followed', () => {
    const ref = REF_PAGE.replace('May 22, 2024', '22 May 2024');
    const r = buildConvertedBlogPage({ reference: { page: ref, head: REF_HEAD }, post: post(), origin: ORIGIN, today: '2026-11-25' });
    assert.match(r.page, /November 24, 2026|24 November 2026/); assert.match(r.page, /24 November 2026/);
  });
});

describe('refusals: the draft is blocked, nothing is written', () => {
  test('a reference with an unexpected shape', () => {
    for (const ref of [REF_PAGE.replace('<div class="blog-content">', '<div class="x">'), REF_PAGE.replace('<h1>', '<h2>').replace('</h1>', '</h2>'), REF_PAGE.replace(/"headInclude".*\n/, ''), 'no front matter here']) {
      const r = buildConvertedBlogPage({ reference: { page: ref, head: REF_HEAD }, post: post(), origin: ORIGIN });
      assert.equal(r.ok, false); assert.equal(r.reason, 'reference-shape');
    }
    assert.equal(buildConvertedBlogPage({ reference: { page: REF_PAGE, head: '<title>other</title>' }, post: post(), origin: ORIGIN }).reason, 'reference-shape');
  });
  test('a draft with no sections', () => assert.equal(build({ sections: [] }).reason, 'no-content'));
  test('if the draft itself reuses the reference article\'s distinctive text, it is caught', () => {
    const r = build({ sections: [{ heading: 'x', body: 'The reference lead sentence about something specific.' }] });
    assert.equal(r.ok, false); assert.equal(r.reason, 'leftover');
  });
});

describe('addListingCard: the new post is listed on the site\'s own listing page', () => {
  const LISTING = `<section class="blog-grid">
            <a href="../existing-one/" class="blog-card"><img src="../../images/blog/b1.jpg" alt="Old alt" loading="lazy" decoding="async"><div><span class="blog-date">6 March 2025</span><h2>Existing one</h2><p>Existing summary.</p></div></a>
            <a href="../existing-two/" class="blog-card"><img src="../../images/blog/b2.jpg" alt="Other" loading="lazy" decoding="async"><div><span class="blog-date">1 June 2024</span><h2>Existing two</h2><p>Second summary.</p></div></a>
        </section>`;
  const args = () => ({ post: post(), relativeHref: '../new-supply-chain-post/', image: { src: '../../images/blog/new.webp', alt: 'A warehouse floor' }, today: '2026-11-25' });
  test('a card in the site\'s own markup is inserted before the first one, with the new post\'s details and the listing\'s date style', () => {
    const r = addListingCard(LISTING, args()); assert.equal(r.ok, true);
    assert.match(r.content, /<a href="\.\.\/new-supply-chain-post\/" class="blog-card"><img src="\.\.\/\.\.\/images\/blog\/new\.webp" alt="A warehouse floor" loading="lazy" decoding="async"><div><span class="blog-date">24 November 2026<\/span><h2>How Supply Chains Learn<\/h2><p>A short lead for the new article\.<\/p><\/div><\/a>/);
    assert.ok(r.content.indexOf('new-supply-chain-post') < r.content.indexOf('existing-one'));
    assert.match(r.content, /existing-two/); assert.equal((r.content.match(/class="blog-card"/g) || []).length, 3);
  });
  test('the existing cards are untouched', () => {
    const r = addListingCard(LISTING, args()); const at = r.content.indexOf('<a href="../existing-one/"');
    assert.equal(r.content.slice(at).replace(/\s+/g, ' ').includes(LISTING.slice(LISTING.indexOf('<a href="../existing-one/"')).replace(/\s+/g, ' ')), true);
  });
  test('a listing with no card of the expected kind is reported, never guessed at', () => assert.equal(addListingCard('<div>nothing</div>', args()).reason, 'no-card-found'));
});

describe('helpers', () => {
  test('front matter get/set keeps the rest of the line', () => {
    const fm = '"title": "A | B", # SEOAI:TITLE\n"x": "1"';
    assert.equal(setFmValue(fm, 'title', 'New "quoted" | B'), '"title": "New \\"quoted\\" | B", # SEOAI:TITLE\n"x": "1"');
    assert.equal(fmValue(setFmValue(fm, 'title', 'New "q"'), 'title'), 'New "q"'); assert.equal(setFmValue(fm, 'nope', 'x'), null);
  });
  test('balancedDivEnd handles nesting and unclosed divs', () => {
    const t = '<div class="a"><div>x</div><div><div>y</div></div></div>tail'; assert.equal(t.slice(balancedDivEnd(t, 0)), 'tail'); assert.equal(balancedDivEnd('<div><div></div>', 0), -1);
  });
  test('dates follow the style of the example', () => {
    assert.equal(formatDate('2026-08-18', '22 August 2026'), '18 August 2026'); assert.equal(formatDate('2025-03-06', 'March 06, 2025'), 'March 06, 2025'); assert.equal(formatDate('2024-05-22', 'May 22, 2024'), 'May 22, 2024'); assert.equal(formatDate('nope', 'May 22, 2024'), null);
  });
  test('paragraphs are escaped and lists recognised', () => { assert.equal(renderParagraphs('a <b>\n\n- x\n- y'), '<p>a &lt;b&gt;</p>\n                <ul><li>x</li><li>y</li></ul>'); });
});
