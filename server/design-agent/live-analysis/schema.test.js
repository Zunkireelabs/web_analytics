import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPageType, PAGE_TYPES, PRODUCT_PAGE_TYPES } from './schema.js';

describe('classifyPageType', () => {
  test('a bare content-hub path is a listing page', () => {
    assert.equal(classifyPageType('https://zunkireelabs.com/blog/'), 'blog-listing');
    assert.equal(classifyPageType('https://zunkireelabs.com/resources/'), 'blog-listing');
    assert.equal(classifyPageType('https://zunkireelabs.com/resources'), 'blog-listing');
  });

  test('a slug nested under a content-hub path is an article, including non-blog hub names', () => {
    assert.equal(classifyPageType('https://zunkireelabs.com/blog/some-post/'), 'blog-article');
    assert.equal(classifyPageType('https://zunkireelabs.com/resources/ai-search-stack-guide/'), 'blog-article');
    assert.equal(classifyPageType('https://example.com/guides/how-to-x'), 'blog-article');
    assert.equal(classifyPageType('https://example.com/insights/q3-report'), 'blog-article');
    assert.equal(classifyPageType('https://example.com/learn/getting-started'), 'blog-article');
  });

  test('a genuine full-section page still falls through to other, not blog-article', () => {
    assert.equal(classifyPageType('https://zunkireelabs.com/about/'), 'other');
    assert.equal(classifyPageType('https://zunkireelabs.com/team/'), 'other');
    assert.equal(classifyPageType('https://zunkireelabs.com/contact/'), 'other');
  });

  test('root path is the homepage, and an unparseable url falls through to other', () => {
    assert.equal(classifyPageType('https://zunkireelabs.com/'), 'homepage');
    assert.equal(classifyPageType('not a url'), 'other');
  });
});

describe('classifyPageType — product sites (propertyType: product)', () => {
  const product = { propertyType: 'product' };
  const url = (path) => `https://zennly.io${path}`;

  test('classifies a SaaS product site into product page types', () => {
    assert.equal(classifyPageType(url('/pricing/'), product), 'pricing');
    assert.equal(classifyPageType(url('/features/'), product), 'features');
    assert.equal(classifyPageType(url('/features/online-booking/'), product), 'features');
    assert.equal(classifyPageType(url('/how-it-works/'), product), 'how-it-works');
    assert.equal(classifyPageType(url('/demo/'), product), 'demo');
    assert.equal(classifyPageType(url('/case-study/'), product), 'case-study');
    assert.equal(classifyPageType(url('/customers/acme/'), product), 'case-study');
  });

  test('files a case study under /resources/ as case-study, not a blog article', () => {
    assert.equal(classifyPageType(url('/resources/acme-case-study/'), product), 'case-study');
    assert.equal(classifyPageType(url('/resources/ai-search-guide/'), product), 'blog-article');
  });

  test('keeps homepage, blog, legal and solutions behaviour for product sites', () => {
    assert.equal(classifyPageType(url('/'), product), 'homepage');
    assert.equal(classifyPageType(url('/blog/'), product), 'blog-listing');
    assert.equal(classifyPageType(url('/blog/some-post/'), product), 'blog-article');
    assert.equal(classifyPageType(url('/privacy-policy/'), product), 'legal');
    assert.equal(classifyPageType(url('/solutions/spa/'), product), 'service');
  });

  test('NEVER applies product types to website tenants (multi-tenant safety)', () => {
    for (const opts of [undefined, {}, { propertyType: 'website' }]) {
      assert.equal(classifyPageType('https://zunkireelabs.com/resources/zenly-case-study/', opts), 'blog-article');
      assert.equal(classifyPageType('https://zunkireelabs.com/products/dental-ai/', opts), 'service');
      assert.equal(classifyPageType('https://zunkireelabs.com/pricing/', opts), 'other');
      assert.equal(classifyPageType('https://zunkireelabs.com/features/', opts), 'other');
      assert.equal(classifyPageType('https://zunkireelabs.com/how-it-works/', opts), 'other');
    }
  });

  test('exposes the product types in PAGE_TYPES', () => {
    for (const t of PRODUCT_PAGE_TYPES) assert.ok(PAGE_TYPES.includes(t), t);
  });
});
