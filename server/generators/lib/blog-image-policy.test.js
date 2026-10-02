import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featuredImageWanted, extractCategory, INSIGHT_CATEGORY } from './blog-image-policy.js';

test('default: every post wants an image, whatever its category', () => {
  assert.equal(featuredImageWanted(undefined, {}), true);
  assert.equal(featuredImageWanted({ dir: 'src/blog' }, { category: 'Business' }), true);
});

test("'insights-only': only Insights posts want one", () => {
  const target = { featuredImage: 'insights-only' };
  assert.equal(featuredImageWanted(target, { category: INSIGHT_CATEGORY }), true);
  assert.equal(featuredImageWanted(target, { category: 'Business' }), false);
  assert.equal(featuredImageWanted(target, {}), false);
});

test('an unknown setting value falls back to the default, never to "no images"', () => {
  assert.equal(featuredImageWanted({ featuredImage: 'sometimes' }, {}), true);
});

test('extractCategory reads quoted and bare values, null when absent', () => {
  assert.equal(extractCategory('---\ncategory: Insights\n---'), 'Insights');
  assert.equal(extractCategory('---\ncategory: "AI Technology"\n---'), 'AI Technology');
  assert.equal(extractCategory("---\ncategory: 'Business'\n---"), 'Business');
  assert.equal(extractCategory('---\ntitle: x\n---'), null);
});
