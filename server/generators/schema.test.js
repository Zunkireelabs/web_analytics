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
// the real page content) kept getting offered the same unusable,
// all-placeholder Review draft on every audit run. needsArticleFallback is
// what schema.js's generate() uses to detect that and fall back to Article.
describe('needsArticleFallback', () => {
  test('true when every one of a risky type\'s defining facts is a placeholder', () => {
    const placeholders = ['author.name', 'reviewer.name', 'reviewRating.ratingValue'];
    assert.equal(needsArticleFallback('Review', placeholders), true);
  });

  test('false when at least one defining fact resolved to real content', () => {
    const placeholders = ['reviewer.name']; // author.name and reviewRating.ratingValue were real
    assert.equal(needsArticleFallback('Review', placeholders), false);
  });

  test('false for a type with no risky-core-fields entry (e.g. Article itself)', () => {
    assert.equal(needsArticleFallback('Article', ['headline']), false);
  });

  test('false for a non-risky type like ContactPage even with placeholders', () => {
    assert.equal(needsArticleFallback('ContactPage', ['email']), false);
  });
});

test('meta.id is still "schema"', () => {
  assert.equal(meta.id, 'schema');
});
