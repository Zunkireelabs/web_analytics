import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isPaginatedListUrl, isUnshippablePaginationFix, CONTENT_FIX_GENERATORS, listingUrlFor, paginatedListDisposition } from './paginated-pages.js';

describe('isPaginatedListUrl', () => {
  test('recognises page N of a listing, with or without a language prefix and trailing slash', () => {
    for (const u of [
      'https://zunkireelabs.com/blog/page/2/', 'https://zunkireelabs.com/blog/page/12',
      'https://zunkireelabs.com/de-ch/blog/page/3/', 'https://zunkireelabs.com/blog/insights/page/2/', '/blog/page/2/',
    ]) assert.equal(isPaginatedListUrl(u), true, u);
  });
  test('does not touch real pages, the first page of a listing, or a page that merely has "page" in its name', () => {
    for (const u of [
      'https://zunkireelabs.com/blog/', 'https://zunkireelabs.com/blog/page/', 'https://zunkireelabs.com/page/about/',
      'https://zunkireelabs.com/blog/how-to-page/2-tips/', 'https://zunkireelabs.com/', '', null, undefined,
    ]) assert.equal(isPaginatedListUrl(u), false, String(u));
  });
});

describe('isUnshippablePaginationFix', () => {
  test('content fixes on a paginated page are unshippable; technical checks are not', () => {
    const u = 'https://zunkireelabs.com/blog/page/2/';
    for (const g of CONTENT_FIX_GENERATORS) assert.equal(isUnshippablePaginationFix(g, u), true, g);
    for (const g of ['canonical', 'robots-fix', 'sitemap', 'redirect-chain-nginx', 'broken-link-fix']) assert.equal(isUnshippablePaginationFix(g, u), false, g);
  });
  test('the same content fix on a normal page is unaffected', () => {
    assert.equal(isUnshippablePaginationFix('faq', 'https://zunkireelabs.com/services/seo/'), false);
  });
});

describe('listingUrlFor', () => {
  test('a numbered page maps to the listing that produces it, on any language prefix', () => {
    assert.equal(listingUrlFor('https://zunkireelabs.com/blog/articles/page/3/'), 'https://zunkireelabs.com/blog/articles/');
    assert.equal(listingUrlFor('https://zunkireelabs.com/de-ch/blog/page/12'), 'https://zunkireelabs.com/de-ch/blog/');
    assert.equal(listingUrlFor('https://zunkireelabs.com/blog/page/2/?utm=x#y'), 'https://zunkireelabs.com/blog/');
  });
  test('anything that is not a numbered page has no listing', () => {
    assert.equal(listingUrlFor('https://zunkireelabs.com/blog/'), null);
    assert.equal(listingUrlFor('https://zunkireelabs.com/blog/how-to-page/2-tips/'), null);
    assert.equal(listingUrlFor(null), null);
  });
});

describe('paginatedListDisposition', () => {
  const u = 'https://zunkireelabs.com/blog/articles/page/4/';
  test('schema is fixed once at the listing', () => {
    assert.deepEqual(paginatedListDisposition('schema', u), { kind: 'fix-at-listing', listingUrl: 'https://zunkireelabs.com/blog/articles/' });
  });
  test('FAQ, Q&A, expansion, refresh, direct answer and links do not apply to a list of post cards', () => {
    for (const g of ['faq', 'qa-content', 'expand-content', 'refresh-content', 'direct-answer', 'internal-links']) assert.deepEqual(paginatedListDisposition(g, u), { kind: 'not-applicable' }, g);
  });
  test('titles, technical checks and normal pages are left exactly as they were', () => {
    assert.equal(paginatedListDisposition('meta-title', u), null);
    for (const g of ['canonical', 'robots-fix', 'sitemap', 'broken-link-fix']) assert.equal(paginatedListDisposition(g, u), null, g);
    assert.equal(paginatedListDisposition('faq', 'https://zunkireelabs.com/services/seo/'), null);
    assert.equal(paginatedListDisposition('schema', 'https://zunkireelabs.com/blog/articles/'), null);
  });
});
