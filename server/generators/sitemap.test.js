import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSitemapXml, looksLikeTemplateSource, meta } from './sitemap.js';

// Only exercises buildSitemapXml (pure, no DB/HTTP) — generate()'s
// url_file_map.siteRoot.sitemap resolution and its no-mapping 400 both
// require a real site row via getSiteById, so (same documented exclusion as
// generators/html-lang.test.js) those DB-dependent paths are covered by
// manual/sandbox verification instead.

describe('sitemap generator — buildSitemapXml', () => {
  test('includes both existing and newly discovered URLs', () => {
    const xml = buildSitemapXml([{ loc: '/page-a/' }, { loc: '/page-b/' }], ['/page-c/'], '2026-07-27');
    assert.match(xml, /<loc>\/page-a\/<\/loc>/);
    assert.match(xml, /<loc>\/page-b\/<\/loc>/);
    assert.match(xml, /<loc>\/page-c\/<\/loc>/);
  });

  test('never drops an existing entry (additive-only)', () => {
    const xml = buildSitemapXml([{ loc: '/old-page/' }], [], '2026-07-27');
    assert.match(xml, /<loc>\/old-page\/<\/loc>/);
  });

  test('preserves an existing entry\'s <lastmod>', () => {
    const xml = buildSitemapXml([{ loc: '/a/', lastmod: '2020-01-01' }], [], '2026-07-27');
    assert.match(xml, /<loc>\/a\/<\/loc>\s*\n\s*<lastmod>2020-01-01<\/lastmod>/);
  });

  test('preserves an existing entry\'s <priority>', () => {
    const xml = buildSitemapXml([{ loc: '/a/', priority: '0.8' }], [], '2026-07-27');
    assert.match(xml, /<priority>0\.8<\/priority>/);
  });

  test('preserves an existing entry\'s <changefreq>', () => {
    const xml = buildSitemapXml([{ loc: '/a/', changefreq: 'weekly' }], [], '2026-07-27');
    assert.match(xml, /<changefreq>weekly<\/changefreq>/);
  });

  test('preserves all three metadata fields together, unchanged', () => {
    const xml = buildSitemapXml([{ loc: '/a/', lastmod: '2020-01-01', changefreq: 'weekly', priority: '0.8' }], [], '2026-07-27');
    assert.match(xml, /<loc>\/a\/<\/loc>\s*\n\s*<lastmod>2020-01-01<\/lastmod>\s*\n\s*<changefreq>weekly<\/changefreq>\s*\n\s*<priority>0\.8<\/priority>/);
  });

  test('a new URL gets a real (non-fabricated) lastmod — the date it was added — and no invented priority/changefreq', () => {
    const xml = buildSitemapXml([], ['/new-page/'], '2026-07-27');
    assert.match(xml, /<loc>\/new-page\/<\/loc>\s*\n\s*<lastmod>2026-07-27<\/lastmod>/);
    const newUrlBlock = xml.split('<url>').find((b) => b.includes('/new-page/'));
    assert.doesNotMatch(newUrlBlock, /<priority>/);
    assert.doesNotMatch(newUrlBlock, /<changefreq>/);
  });

  test('an entry with no existing metadata gets no fabricated metadata', () => {
    const xml = buildSitemapXml([{ loc: '/bare/' }], [], '2026-07-27');
    const block = xml.split('<url>').find((b) => b.includes('/bare/'));
    assert.doesNotMatch(block, /<lastmod>/);
    assert.doesNotMatch(block, /<priority>/);
    assert.doesNotMatch(block, /<changefreq>/);
  });

  test('escapes XML-unsafe characters in a URL', () => {
    const xml = buildSitemapXml([], ['/a&b/'], '2026-07-27');
    assert.match(xml, /<loc>\/a&amp;b\/<\/loc>/);
  });

  test('produces a well-formed urlset document', () => {
    const xml = buildSitemapXml([{ loc: '/a/' }], ['/b/'], '2026-07-27');
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.match(xml, /<\/urlset>\s*$/);
  });

  test('meta.id matches the generatorId agents wire into recommendedAction', () => {
    assert.equal(meta.id, 'sitemap');
  });
});

describe('sitemap generator — looksLikeTemplateSource', () => {
  test('flags Eleventy front matter (the zunkireelabs-web src/sitemap.njk shape)', () => {
    assert.equal(looksLikeTemplateSource('---\npermalink: /sitemap.xml\n---\n<?xml version="1.0"?>'), true);
  });

  test('flags a Nunjucks/Liquid loop even without front matter', () => {
    assert.equal(looksLikeTemplateSource('<?xml version="1.0"?>\n{%- for page in collections.all %}\n{{ page.url }}'), true);
  });

  test('flags an EJS tag', () => {
    assert.equal(looksLikeTemplateSource('<?xml version="1.0"?>\n<%= url %>'), true);
  });

  test('does not flag a plain static sitemap.xml', () => {
    assert.equal(looksLikeTemplateSource('<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>/a/</loc></url></urlset>'), false);
  });
});
