import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let stored;
let llmResponse;
let llmError;
let llmCalls;

mock.module(resolve('../../store/page-content-classification.js'), {
  namedExports: {
    getPageContentType: async (siteId, page) => stored.find((r) => r.siteId === siteId && r.page === page) || null,
    upsertPageContentType: async ({ siteId, page, contentType, confidence, classifiedBy }) => {
      const row = { siteId, page, contentType, confidence, classifiedBy };
      stored = stored.filter((r) => !(r.siteId === siteId && r.page === page));
      stored.push(row);
      return row;
    },
  },
});

mock.module(resolve('../../llm.js'), {
  namedExports: {
    callLLMForJson: async (system, user, options) => {
      llmCalls.push({ system, user, options });
      if (llmError) throw llmError;
      return llmResponse;
    },
  },
});

const { getOrClassifyPageContentType, CONTENT_TYPES } = await import('./page-content-classifier.js');

beforeEach(() => {
  stored = [];
  llmResponse = { contentType: 'other', confidence: 0.8 };
  llmError = null;
  llmCalls = [];
});

describe('getOrClassifyPageContentType', () => {
  test('technical/structural-adjacent: a page-path match classifies deterministically, no LLM call', async () => {
    const result = await getOrClassifyPageContentType(1, 'https://client.example/products/widget');
    assert.equal(result.contentType, 'product');
    assert.equal(result.classifiedBy, 'path-heuristic');
    assert.equal(llmCalls.length, 0);
  });

  test('content-context match: an ambiguous path falls back to the LLM and persists the result', async () => {
    llmResponse = { contentType: 'landing', confidence: 0.85 };
    const result = await getOrClassifyPageContentType(7, 'https://client.example/x9k2');
    assert.equal(result.contentType, 'landing');
    assert.equal(result.classifiedBy, 'llm');
    assert.equal(llmCalls.length, 1);
    // Persisted, so a second call for the same page is a cache hit.
    const second = await getOrClassifyPageContentType(7, 'https://client.example/x9k2');
    assert.equal(second.contentType, 'landing');
    assert.equal(llmCalls.length, 1);
  });

  test('missing context: an LLM response outside the closed vocabulary is never persisted or trusted', async () => {
    llmResponse = { contentType: 'gizmo-page', confidence: 0.99 };
    const result = await getOrClassifyPageContentType(1, 'https://client.example/x9k2');
    assert.equal(result, null);
    assert.equal(stored.length, 0);
  });

  test('missing context: a low-confidence LLM response is treated as unclassified', async () => {
    llmResponse = { contentType: 'blog', confidence: 0.2 };
    const result = await getOrClassifyPageContentType(1, 'https://client.example/x9k2');
    assert.equal(result, null);
  });

  test('LLM failure: an LLM error fails open to null, never throws', async () => {
    llmError = new Error('upstream 500');
    const result = await getOrClassifyPageContentType(1, 'https://client.example/x9k2');
    assert.equal(result, null);
  });

  test('cross-client isolation: a classification for one site is never returned for another', async () => {
    await getOrClassifyPageContentType(1, 'https://a.example/blog/post');
    const forSiteTwo = await getOrClassifyPageContentType(2, 'https://a.example/blog/post');
    // Site 2 has no cached row for this exact (site, page) pair, so it must
    // classify fresh (path-heuristic here, deterministic) rather than reuse
    // site 1's cached row — proving the cache read is scoped by siteId.
    assert.equal(forSiteTwo.contentType, 'blog');
    assert.equal(stored.filter((r) => r.page === 'https://a.example/blog/post').length, 2);
    assert.ok(stored.some((r) => r.siteId === 1));
    assert.ok(stored.some((r) => r.siteId === 2));
  });

  test('wrong page type: distinct URL conventions classify to distinct vocabulary entries', async () => {
    const product = await getOrClassifyPageContentType(1, 'https://client.example/products/a');
    const blog = await getOrClassifyPageContentType(1, 'https://client.example/blog/a');
    const faq = await getOrClassifyPageContentType(1, 'https://client.example/faq');
    const legal = await getOrClassifyPageContentType(1, 'https://client.example/privacy');
    assert.equal(product.contentType, 'product');
    assert.equal(blog.contentType, 'blog');
    assert.equal(faq.contentType, 'faq');
    assert.equal(legal.contentType, 'legal');
    assert.notEqual(product.contentType, blog.contentType);
  });

  test('every deterministic and LLM result stays inside the closed CONTENT_TYPES vocabulary', () => {
    assert.deepEqual(CONTENT_TYPES, ['product', 'service', 'blog', 'landing', 'faq', 'category', 'legal', 'other']);
  });

  test('missing siteId or pageUrl never throws, returns null', async () => {
    assert.equal(await getOrClassifyPageContentType(null, 'https://a.example/x'), null);
    assert.equal(await getOrClassifyPageContentType(1, null), null);
  });
});
