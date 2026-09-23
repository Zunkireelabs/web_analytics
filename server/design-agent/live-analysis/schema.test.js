import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPageType } from './schema.js';

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
