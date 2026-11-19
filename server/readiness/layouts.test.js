import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLayoutText, deriveKeys, layoutRef, includeRefs } from './layouts.js';
import { layoutDerivesHead } from './stacks.js';

// REAL FILES: Zunkireelabs/web-zenly (stage, 2026-11-19): src/_includes/_head-meta.njk (lines 1-7, 15-20), base.njk (head), blog-article.njk (first lines).
const HEAD_META = `{% set pageTitle = title or site.defaultTitle %}
{% set pageDescription = metaDescription or site.defaultDescription %}
<title>{{ pageTitle }}</title>
<meta name="description" content="{{ pageDescription }}" />
<link rel="canonical" href="{{ pageUrl }}" />
<meta property="og:type" content="{{ ogType or 'website' }}" />
<meta property="og:title" content="{{ pageTitle }}" />
<meta property="og:description" content="{{ pageDescription }}" />
<meta property="og:url" content="{{ pageUrl }}" />
`;
const BASE = `---\n---\n<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  {% include "_head-meta.njk" %}\n  <link rel="stylesheet" href="/assets/css/tailwind.css?v=47" />\n</head>\n<body>{{ content | safe }}</body>\n</html>\n`;
const BLOG_LAYOUT = `---\nlayout: base.njk\n---\n{% from "schema/breadcrumb.njk" import breadcrumbSchema with context %}\n<main>{{ content | safe }}</main>\n`;
const PAGE = '---\nlayout: layouts/blog-article.njk\ntitle: "Discount Leakage"\nmetaDescription: "x"\n---\n<p>Body</p>\n';
const store = { 'src/_includes/layouts/blog-article.njk': BLOG_LAYOUT, 'src/_includes/base.njk': BASE, 'src/_includes/_head-meta.njk': HEAD_META };
const read = async (p) => store[p] ?? null;

test('reads the layout reference from YAML or JSON front matter, and the includes from a template', () => {
  assert.equal(layoutRef(PAGE), 'layouts/blog-article.njk');
  assert.equal(layoutRef('---\n{\n  "layout": "layouts/base.njk"\n}\n---\n'), 'layouts/base.njk');
  assert.equal(layoutRef('no front matter'), null);
  assert.deepEqual(includeRefs(BASE), ['_head-meta.njk']);
});

test('follows page -> layout -> parent layout -> include, and finds the head the layout chain really renders', async () => {
  const text = await collectLayoutText({ pagePath: 'src/blog/discount-leakage.njk', pageContent: PAGE, readFile: read, repoFiles: Object.keys(store) });
  assert.match(text, /<meta name="description"/);
  assert.match(text, /og:title/);
  assert.deepEqual(layoutDerivesHead(text), { OPENGRAPH: true, CANONICAL: true });
});

test('the front-matter keys are DERIVED from the layout: description is metaDescription (through a {% set %}), title is title', async () => {
  const text = await collectLayoutText({ pagePath: 'p.njk', pageContent: PAGE, readFile: read, repoFiles: Object.keys(store) });
  assert.deepEqual(deriveKeys(text), { description: 'metaDescription', title: 'title' });
  assert.deepEqual(deriveKeys('<title>{{ page.title }}</title><meta name="description" content="{{ description }}">'), { title: 'title', description: 'description' });
  assert.deepEqual(deriveKeys('<head></head>'), {});
});

test('a loop in the includes, a missing file and a page with no layout all end cleanly', async () => {
  const loop = { 'src/_includes/a.njk': '{% include "b.njk" %}', 'src/_includes/b.njk': '{% include "a.njk" %}' };
  assert.equal(typeof await collectLayoutText({ pagePath: 'p', pageContent: '---\nlayout: a.njk\n---\n', readFile: async (p) => loop[p] ?? null, repoFiles: Object.keys(loop) }), 'string');
  assert.equal(await collectLayoutText({ pagePath: 'p', pageContent: '---\nlayout: nope.njk\n---\n', readFile: read, repoFiles: [] }), '');
  assert.equal(await collectLayoutText({ pagePath: 'p', pageContent: 'plain', readFile: read, repoFiles: Object.keys(store) }), '');
});

test('Astro: the first component\'s import is followed to the layout file, resolved relative to the page', async () => {
  const astro = { 'src/layouts/Layout.astro': '---\n---\n<title>{title}</title>\n<link rel="canonical" href={canonical}>\n<meta property="og:title" content={ogTitle}>\n' };
  const page = "---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout title=\"T\" description=\"D\">\n</Layout>\n";
  const text = await collectLayoutText({ pagePath: 'src/pages/pricing.astro', pageContent: page, readFile: async (p) => astro[p] ?? null, repoFiles: Object.keys(astro) });
  assert.deepEqual(layoutDerivesHead(text), { OPENGRAPH: true, CANONICAL: true });
});
