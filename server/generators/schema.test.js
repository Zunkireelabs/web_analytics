import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlaceholders, needsArticleFallback, meta, generate } from './schema.js';

// Stubs global fetch (the only thing page-content.js's fetchHtml calls) so
// generate()'s pre-LLM guards (requireGroundedContent, the duplicate-schema
// check) can be exercised without a real network call or LLM API key —
// both guards run and throw before generate() ever reaches callLLMForJson,
// so no LLM call happens in these tests.
function stubFetchHtml(html) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => html,
    url,
  });
  return () => { globalThis.fetch = original; };
}

const REAL_ARTICLE_PARAGRAPH = 'This is a real, substantial paragraph of genuine article content about the topic at hand, '
  + 'written with enough real words to clear the grounding floor so the generator treats this page as having actual '
  + 'extractable content rather than a thin or boilerplate-only page. '.repeat(3);

describe('schema generator — content-extraction and duplicate-schema guards', () => {
  test('refuses to draft schema when the page has only nav/footer boilerplate (thin extraction)', async () => {
    const restore = stubFetchHtml(
      '<html><head><title>T</title></head><body>'
      + '<nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>'
      + '<footer>Copyright 2026 Example Co. All rights reserved.</footer>'
      + '</body></html>',
    );
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: 'https://example.com/thin', schemaType: 'Article' } }),
        /not enough real page content/i,
      );
    } finally { restore(); }
  });

  test('refuses to draft a duplicate of schema the page already really has', async () => {
    const restore = stubFetchHtml(
      '<html><head><title>Real Article</title>'
      + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Real Article"}</script>'
      + `</head><body><article><h1>Real Article</h1><p>${REAL_ARTICLE_PARAGRAPH}</p></article></body></html>`,
    );
    try {
      await assert.rejects(
        () => generate({ siteId: 1, params: { page: 'https://example.com/real', schemaType: 'Article' } }),
        /already has real "Article" schema/i,
      );
    } finally { restore(); }
  });
});

describe('resolvePlaceholders', () => {
  const PLACEHOLDER = '[NEEDS INPUT — not found on the page]';

  test('finds nested placeholders by dotted path', () => {
    const jsonLd = {
      '@type': 'Review',
      author: { name: PLACEHOLDER },
      reviewRating: { ratingValue: PLACEHOLDER, bestRating: '5' },
    };
    const fields = resolvePlaceholders(jsonLd);
    assert.deepEqual(fields.sort(), ['author.name', 'reviewRating.ratingValue']);
  });

  test('auto-fills date fields in place instead of flagging them', () => {
    const jsonLd = { '@type': 'Article', datePublished: PLACEHOLDER };
    const fields = resolvePlaceholders(jsonLd);
    assert.deepEqual(fields, []);
    assert.match(jsonLd.datePublished, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('no placeholders when every field is real', () => {
    const jsonLd = { '@type': 'Article', headline: 'Real title' };
    assert.deepEqual(resolvePlaceholders(jsonLd), []);
  });
});

// Regression coverage for a real report: a page with a stale/boilerplate
// "Review" @type already on it (no real reviewer/rating data anywhere in
// the real page content) kept getting offered the same unusable, all-
// placeholder Review draft on every audit run. needsArticleFallback is what
// schema.js's generate() uses to detect that and fall back to Article —
// deliberately type-agnostic (no hardcoded "which fields matter per type"
// list), grounded in the fact that ANY placeholder already blocks
// auto-publish regardless of type, so any non-Article type with even one
// unresolved field falls back, for every type this can ever happen to.
describe('needsArticleFallback', () => {
  test('true for any non-Article type with at least one placeholder', () => {
    assert.equal(needsArticleFallback('Review', ['author.name']), true);
    assert.equal(needsArticleFallback('Product', ['offers.price']), true);
    assert.equal(needsArticleFallback('ContactPage', ['email']), true);
    assert.equal(needsArticleFallback('SomeFutureType', ['anyField']), true);
  });

  test('false when there are no placeholders at all, whatever the type', () => {
    assert.equal(needsArticleFallback('Review', []), false);
    assert.equal(needsArticleFallback('Product', []), false);
  });

  test('false for Article itself, even with placeholders — nowhere left to fall back to', () => {
    assert.equal(needsArticleFallback('Article', ['headline']), false);
  });
});

test('meta.id is still "schema"', () => {
  assert.equal(meta.id, 'schema');
});
