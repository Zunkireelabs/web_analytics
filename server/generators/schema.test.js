import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlaceholders, needsArticleFallback, meta } from './schema.js';

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
