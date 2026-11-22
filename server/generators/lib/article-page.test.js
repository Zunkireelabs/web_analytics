import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isArticlePageUrl, siteArticleUrlRegexes, matchesSiteArticleUrl, isDeclaredArticleType, _resetArticlePageCacheForTest } from './article-page.js';

beforeEach(() => _resetArticlePageCacheForTest());

describe('isArticlePageUrl', () => {
  test('true when the page analysis says it is an article', async () => {
    assert.equal(await isArticlePageUrl('https://x.test/a', { analyze: async () => ({ ok: true, analysis: { isArticlePage: true } }) }), true);
  });
  test('false for a landing page', async () => {
    assert.equal(await isArticlePageUrl('https://x.test/b', { analyze: async () => ({ ok: true, analysis: { isArticlePage: false } }) }), false);
  });
  test('fails closed: an unreadable page or a thrown error is NOT an article', async () => {
    assert.equal(await isArticlePageUrl('https://x.test/c', { analyze: async () => ({ ok: false }) }), false);
    assert.equal(await isArticlePageUrl('https://x.test/d', { analyze: async () => { throw new Error('boom'); } }), false);
    assert.equal(await isArticlePageUrl('', { analyze: async () => ({ ok: true, analysis: { isArticlePage: true } }) }), false);
  });
  test('caches, so the gate running several times reads the page once', async () => {
    let calls = 0;
    const analyze = async () => { calls += 1; return { ok: true, analysis: { isArticlePage: true } }; };
    await isArticlePageUrl('https://x.test/e', { analyze });
    await isArticlePageUrl('https://x.test/e', { analyze });
    assert.equal(calls, 1);
  });
});

describe("the site's own blog URL pattern (works before the post is published)", () => {
  const site = { url_file_map: { newContentTargets: { 'blog-outline': { urlPattern: '/blogs/{slug}' }, 'landing-page': { urlPattern: '/{slug}' } } } };
  test('matches a post URL, with or without a trailing slash, and nothing else', () => {
    assert.equal(matchesSiteArticleUrl('https://a.test/blogs/new-post', site), true);
    assert.equal(matchesSiteArticleUrl('https://a.test/blogs/new-post/', site), true);
    assert.equal(matchesSiteArticleUrl('https://a.test/blogs', site), false);
    assert.equal(matchesSiteArticleUrl('https://a.test/study-in-the-uk', site), false);
    assert.equal(matchesSiteArticleUrl('https://a.test/blogs/a/b', site), false);
  });
  test('a bare "/{slug}" blog pattern is refused, because it would match every page', () => {
    assert.deepEqual(siteArticleUrlRegexes({ url_file_map: { newContentTargets: { 'blog-outline': { urlPattern: '/{slug}' } } } }), []);
    assert.deepEqual(siteArticleUrlRegexes(null), []);
  });
  test('an unpublished post is an article WITHOUT reading the page (the fetch would fail)', async () => {
    let calls = 0;
    const analyze = async () => { calls += 1; return { ok: false }; };
    assert.equal(await isArticlePageUrl('https://a.test/blogs/not-live-yet', { analyze, site }), true);
    assert.equal(calls, 0);
    assert.equal(await isArticlePageUrl('https://a.test/study-in-the-uk', { analyze, site }), false);
  });
});

describe('a declared pageType (the only signal when there is no page URL)', () => {
  test('blog / article / blog-post count, anything else does not', () => {
    for (const t of ['blog', 'Blog', ' article ', 'blog-post']) assert.equal(isDeclaredArticleType(t), true);
    for (const t of ['landing-page', 'service', '', null, undefined]) assert.equal(isDeclaredArticleType(t), false);
  });
  test('works with no page at all, and never reads a page', async () => {
    let calls = 0;
    const analyze = async () => { calls += 1; return { ok: false }; };
    assert.equal(await isArticlePageUrl(null, { analyze, pageType: 'blog' }), true);
    assert.equal(await isArticlePageUrl(null, { analyze, pageType: 'landing-page' }), false);
    assert.equal(calls, 0);
  });
});
