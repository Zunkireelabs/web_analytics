import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isArticlePageUrl, _resetArticlePageCacheForTest } from './article-page.js';

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
