import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPageType, isFacetedUrl, isGeneratedPage, PAGE_TYPES, generatedPageBlockReason } from './page-type.js';

const T = (u, site = {}) => classifyPageType(site, u);
const DECLARED = { url_file_map: { pageTypes: [{ match: '^/never-matches$', type: 'content' }] } };

describe('page type', () => {
  test('common marketplace and content URL shapes', () => {
    assert.equal(T('https://z.io/'), 'home');
    assert.equal(T('https://z.io/blog'), 'blog-index');
    assert.equal(T('https://z.io/blog/how-to-list'), 'blog-post');
    assert.equal(T('https://z.io/category/hair', DECLARED), 'category');
    assert.equal(T('https://z.io/salons/glow-spa', DECLARED), 'listing');
    assert.equal(T('https://z.io/sellers/ana', DECLARED), 'seller');
    assert.equal(T('https://z.io/search?q=hair', DECLARED), 'search');
  });

  test('an unrecognised path stays "content" so non-marketplace sites behave as before', () => {
    assert.equal(T('https://z.io/about'), 'content');
    assert.equal(T('not a url'), 'content');
    assert.equal(T(undefined), 'content');
  });

  test('the site\'s own url_file_map.pageTypes wins over the built-ins; bad rules are skipped', () => {
    const site = { url_file_map: { pageTypes: [{ match: '(', type: 'listing' }, { match: '^/stay/[^/]+$', type: 'listing' }, { match: '^/blog/x$', type: 'bogus' }] } };
    assert.equal(T('https://z.io/stay/cabin', site), 'listing');
    assert.equal(T('https://z.io/blog/x', site), 'blog-post');
  });

  test('generated pages are category, listing, seller and search only', () => {
    for (const [u, want] of [['/category/a', true], ['/salons/a', true], ['/sellers/a', true], ['/search', true], ['/blog/a', false], ['/about', false], ['/', false]]) {
      assert.equal(isGeneratedPage(DECLARED, u), want, u);
    }
    assert.ok(PAGE_TYPES.includes('listing'));
  });

  test('faceted URLs: only sort, page and filter parameters', () => {
    assert.equal(isFacetedUrl('https://z.io/category/hair?sort=price&page=2'), true);
    assert.equal(isFacetedUrl('https://z.io/category/hair'), false);
    assert.equal(isFacetedUrl('https://z.io/p?utm_source=x'), false);
    assert.equal(isFacetedUrl('nonsense'), false);
  });

  test('without a declared layout a /services/x page is ordinary content, so existing sites are unchanged', () => {
    assert.equal(T('https://z.io/services/seo'), 'content');
    assert.equal(T('https://z.io/products/widget'), 'content');
    assert.equal(generatedPageBlockReason({}, 'https://z.io/services/seo', 'faq'), null);
  });

  test('a declared marketplace blocks content edits on generated pages only', () => {
    assert.match(generatedPageBlockReason(DECLARED, 'https://z.io/salons/glow', 'faq'), /listing page/);
    assert.equal(generatedPageBlockReason(DECLARED, 'https://z.io/salons/glow', 'meta-title'), null);
    assert.equal(generatedPageBlockReason(DECLARED, 'https://z.io/blog/post', 'faq'), null);
  });
});
