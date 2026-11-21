import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planEleventyPagination, ELEVENTY_ALIAS } from './eleventy-recipe.js';

// Shaped like the real listings checked on 2026-11-21 (generic wording): YAML front matter, a JSON-LD loop inside <script> and the visible cards.
const listing = ({ front = '', loops = true, extraBody = '' } = {}) => `---
title: "Guides and Advice | Example Co"
description: "Practical guides from Example Co."
layout: base.njk
${front}eleventyComputed:
  headExtra: |
    <link rel="stylesheet" href="/css/blog.css">
tags: []
permalink: /blog/
---
{% if collections.blog.length > 0 %}
<script type="application/ld+json">
{"@type":"ItemList","itemListElement":[{% for post in collections.blog %}{"url":"{{ post.url }}"}{% if not loop.last %},{% endif %}{% endfor %}]}
</script>
{% endif %}
<section>
{% if collections.blog.length > 0 %}
<div class="row">
${loops ? `{% for post in collections.blog %}
  <article><h5><a href="{{ post.url }}">{{ post.data.title }}</a></h5></article>
{% endfor %}` : '<p>none</p>'}
</div>
{% else %}<p>Coming soon.</p>{% endif %}
</section>
${extraBody}`;
const plan = (source, opts = {}) => planEleventyPagination({ source, basePath: '/blog/', pageSize: 12, buttonClass: 'btn primary', ...opts });
const refusedWith = (source, reason, opts) => { const r = plan(source, opts); assert.equal(r.ok, false, `expected a refusal (${reason})`); assert.equal(r.reason, reason, r.error); return r; };

describe('the happy path', () => {
  const r = plan(listing());
  const out = r.after;
  test('succeeds and puts Eleventy pagination in the front matter', () => {
    assert.equal(r.ok, true);
    assert.match(out, /^pagination:\n {2}data: collections\.blog\n {2}size: 12\n {2}alias: pagedPosts$/m);
  });
  test('page 1 keeps the listing URL, later pages go under /page/<n>/, and the old permalink is replaced, not duplicated', () => {
    assert.match(out, /^permalink: "\{% if pagination\.pageNumber == 0 %\}\/blog\/\{% else %\}\/blog\/page\/\{\{ pagination\.pageNumber \+ 1 \}\}\/\{% endif %\}"$/m);
    assert.equal((out.match(/^permalink:/gm) || []).length, 1);
  });
  test('each page gets its own title and description, and page 1 keeps the original text exactly', () => {
    assert.match(out, /title: "\{% if pagination\.pageNumber == 0 %\}Guides and Advice \| Example Co\{% else %\}Guides and Advice, Page \{\{ pagination\.pageNumber \+ 1 \}\} \| Example Co\{% endif %\}"/);
    assert.match(out, /description: "\{% if pagination\.pageNumber == 0 %\}Practical guides from Example Co\.\{% else %\}Practical guides from Example Co\. \(Page/);
  });
  test('it merges into an existing eleventyComputed block without losing what was there', () => {
    assert.equal((out.match(/^eleventyComputed:/gm) || []).length, 1);
    assert.match(out, /headExtra: \|\n {4}<link rel="stylesheet" href="\/css\/blog\.css">/);
  });
  test('BOTH loops over the posts (the JSON-LD one and the visible cards) show the same slice', () => {
    assert.equal((out.match(/for post in pagedPosts/g) || []).length, 2);
    assert.ok(!/for post in collections\.blog/.test(out));
  });
  test('the pager comes after the VISIBLE loop, not after the script one', () => {
    const cards = out.indexOf('<article>'), pager = out.indexOf('<nav class="blog-pager"'), script = out.indexOf('</script>');
    assert.ok(script < cards && cards < pager);
    assert.equal((out.match(/<nav class="blog-pager"/g) || []).length, 1);
  });
  test('the pager reuses the site\'s own button classes, marks the current page, and carries rel prev/next', () => {
    assert.match(out, /<a class="btn primary" href="\{\{ pagination\.href\.previous \}\}" rel="prev">/);
    assert.match(out, /<span class="btn primary" aria-current="page">/);
    assert.match(out, /rel="next">Older posts<\/a>/);
    assert.match(r.notes.join('\n'), /reuses this site's own button classes: btn primary/);
  });
  test('the rest of the file is untouched', () => {
    assert.match(out, /layout: base\.njk/);
    assert.match(out, /\{% else %\}<p>Coming soon\.<\/p>\{% endif %\}/);
    assert.match(out, /^tags: \[\]$/m);
  });
  test('it is not applied twice: its own output is refused as already paginated', () => {
    assert.equal(plan(out).reason, 'already-paginated');
  });
  test('without button classes the pager is unstyled and the draft says so', () => {
    const noCls = plan(listing(), { buttonClass: null });
    assert.equal(noCls.ok, true);
    assert.doesNotMatch(noCls.after, /<a class=/);
    assert.match(noCls.notes.join('\n'), /unstyled: style \.blog-pager/);
  });
  test('| reverse on the loop becomes reverse: true', () => {
    const r2 = plan(listing().replaceAll('collections.blog %}', 'collections.blog | reverse %}'));
    assert.equal(r2.ok, true);
    assert.match(r2.after, /^ {2}reverse: true$/m);
    assert.ok(!/\| reverse/.test(r2.after.split('---')[2]), 'the filter is gone from the loops');
  });
  test('a different page size and listing path are honoured', () => {
    const r2 = plan(listing(), { pageSize: 9, basePath: '/journal' });
    assert.match(r2.after, /size: 9/);
    assert.match(r2.after, /\{% if pagination\.pageNumber == 0 %\}\/journal\/\{% else %\}\/journal\/page\//);
  });
  test('CRLF files keep their line endings', () => {
    const r2 = plan(listing().replace(/\n/g, '\r\n'));
    assert.equal(r2.ok, true);
    assert.ok(!/[^\r]\n/.test(r2.after.slice(0, r2.after.indexOf('{% if collections'))), 'front matter lines all end with CRLF');
  });
  test('a title with quotes is escaped so the YAML stays valid', () => {
    const r2 = plan(listing().replace('title: "Guides and Advice | Example Co"', "title: 'The \"best\" guides | Example Co'"));
    assert.equal(r2.ok, true);
    assert.match(r2.after, /title: "\{% if pagination\.pageNumber == 0 %\}The \\"best\\" guides \| Example Co/);
  });
});

describe('refusals: everything it cannot do safely is refused with a specific reason', () => {
  test('no YAML front matter', () => refusedWith('<p>just html</p>\n{% for post in collections.blog %}{% endfor %}', 'no-yaml-front-matter'));
  test('JSON front matter (the hand-written mobilise listing)', () => refusedWith('---\n{\n  "layout": "layouts/base.njk",\n  "title": "Blog"\n}\n---\n<p>cards</p>\n', 'json-front-matter'));
  test('already paginated (zunkireelabs, chayce)', () => refusedWith(listing({ front: 'pagination:\n  data: collections.blog\n  size: 10\n  alias: posts\n' }), 'already-paginated'));
  test('no loop over a collection: a hand-written list of cards', () => refusedWith(listing({ loops: false }).replace(/\{% for post in collections\.blog %\}.*?\{% endfor %\}/gs, ''), 'no-collection-loop'));
  test('the posts come from a data file or another alias, not a collection', () => refusedWith(listing().replaceAll('collections.blog', 'blogIndex'), 'no-collection-loop'));
  test('loops over two different collections', () => refusedWith(listing().replace('{% for post in collections.blog %}{"url"', '{% for post in collections.news %}{"url"'), 'several-collection-loops'));
  test('a loop filter pagination cannot carry over', () => refusedWith(listing().replaceAll('collections.blog %}', 'collections.blog | sort %}'), 'loop-filters'));
  test('a title edited in place by the setup automation (SEOAI marker)', () => refusedWith(listing().replace('title: "Guides and Advice | Example Co"', 'title: "Guides and Advice | Example Co" # SEOAI:TITLE'), 'title-not-plain'));
  test('a title that is template syntax or a block scalar', () => {
    refusedWith(listing().replace('title: "Guides and Advice | Example Co"', 'title: "{{ site.name }} guides"'), 'title-not-plain');
    refusedWith(listing().replace('title: "Guides and Advice | Example Co"', 'title: >-\n  Guides'), 'title-not-plain');
  });
  test('a description with a SEOAI marker', () => refusedWith(listing().replace('description: "Practical guides from Example Co."', 'description: "Practical guides." # SEOAI:METADESCRIPTION'), 'description-not-plain'));
  test('no title at all', () => refusedWith(listing().replace('title: "Guides and Advice | Example Co"\n', ''), 'no-title'));
  test('eleventyComputed already defines the title', () => refusedWith(listing().replace('eleventyComputed:\n', 'eleventyComputed:\n  title: "x"\n'), 'computed-title'));
  test('the alias name is already used', () => refusedWith(listing({ extraBody: '<p>{{ pagedPosts }}</p>' }), 'alias-in-use'));
  test('every loop is inside a <script>: no visible list to paginate', () => refusedWith(listing({ loops: false }), 'no-visible-loop'));
  test('the posts are shown in two visible places: unclear where the pager belongs', () => refusedWith(listing({ extraBody: '{% for post in collections.blog %}<i>{{ post.url }}</i>{% endfor %}' }), 'several-listing-loops'));
  test('an unbalanced loop', () => refusedWith(listing().replace('{% endfor %}\n</div>', '</div>'), 'unbalanced-loop'));
  test('every refusal carries a human-readable explanation', () => {
    const r = plan('<p>x</p>');
    assert.equal(r.ok, false);
    assert.ok(r.error.length > 20);
  });
});

test('the alias is a name the recipe owns', () => assert.equal(ELEVENTY_ALIAS, 'pagedPosts'));
