import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFile, resolveActionFile, isPageMapped, resolveNewContentTarget } from './url-file-map.js';

const base = {
  website_domain: 'zennly.io',
  url_file_map: {
    pages: { '/': { file: 'src/index.njk' }, '/business/pricing': { file: 'src/business/pricing.njk' } },
    patterns: [{ match: '^/business/blog/(.+)$', file: 'src/business/blog/$1.md' }, { match: '^/guides/(.+)$', file: 'src/guides/$1.md' }],
    defaults: { placements: { 'meta-title': { file: 'src/_includes/head.njk' } } },
    newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md', urlPattern: '/blog/{slug}/' } },
  },
};
const marketplace = { ...base, scope_exclude_paths: ['/business'] };
const business = { ...base, scope_include_paths: ['/business'] };

describe('implementer path scope', () => {
  test('an unscoped site resolves exactly as before', () => {
    assert.equal(resolveFile(base, 'https://zennly.io/business/pricing'), 'src/business/pricing.njk');
    assert.equal(resolveFile(base, 'https://zennly.io/guides/a'), 'src/guides/a.md');
  });

  test('the marketplace can map its own pages and never the business section', () => {
    assert.equal(resolveFile(marketplace, 'https://zennly.io/guides/a'), 'src/guides/a.md');
    assert.equal(resolveFile(marketplace, 'https://zennly.io/business/pricing'), null);
    assert.equal(resolveFile(marketplace, 'https://zennly.io/business/blog/x'), null);
    assert.equal(isPageMapped(marketplace, 'https://zennly.io/business/blog/x', 'faq'), false);
  });

  test('the business site maps /business and nothing outside it', () => {
    assert.equal(resolveFile(business, 'https://zennly.io/business/blog/x'), 'src/business/blog/x.md');
    assert.equal(resolveFile(business, 'https://zennly.io/guides/a'), null);
    assert.equal(resolveFile(business, 'https://zennly.io/'), null);
  });

  test('a site-wide default placement file cannot be used to reach an out-of-scope page', () => {
    assert.equal(resolveActionFile(base, 'https://zennly.io/business/x', 'meta-title'), 'src/_includes/head.njk');
    assert.equal(resolveActionFile(marketplace, 'https://zennly.io/business/x', 'meta-title'), null);
    assert.equal(resolveActionFile(marketplace, 'https://zennly.io/salons', 'meta-title'), 'src/_includes/head.njk');
  });

  test('a new page whose public URL is outside the scope is refused', () => {
    assert.equal(resolveNewContentTarget(marketplace, 'blog-outline', 'Hello'), 'src/blog/hello.md');
    assert.equal(resolveNewContentTarget(business, 'blog-outline', 'Hello'), null);
    const biz = { ...business, url_file_map: { ...base.url_file_map, newContentTargets: { 'blog-outline': { dir: 'src/business/blog', extension: '.md', urlPattern: '/business/blog/{slug}/' } } } };
    assert.equal(resolveNewContentTarget(biz, 'blog-outline', 'Hello'), 'src/business/blog/hello.md');
    assert.equal(resolveNewContentTarget({ ...biz, scope_include_paths: [], scope_exclude_paths: ['/business'] }, 'blog-outline', 'Hello'), null);
  });
});

describe('design entry URL for a scoped site', () => {
  test('the business section is designed from /business; an unscoped or exclude-only site from the domain root', async () => {
    const { sitePageUrl } = await import('./design-drift.js');
    assert.equal(sitePageUrl({ website_domain: 'zennly.io', scope_include_paths: ['/business/'] }), 'https://zennly.io/business');
    assert.equal(sitePageUrl({ website_domain: 'zennly.io', scope_exclude_paths: ['/business'] }), 'https://zennly.io');
    assert.equal(sitePageUrl({ website_domain: 'zennly.io' }), 'https://zennly.io');
    assert.equal(sitePageUrl({}), null);
  });
});
