import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stockPhotoWanted, featuredImageWanted, extractCategory, INSIGHT_CATEGORY } from './blog-image-policy.js';

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

// stockPhotoWanted: blog-outline's decision once a site may also have generated
// gradient covers (lib/gradient-cover.js).
test('stockPhotoWanted: no covers behaves exactly like featuredImageWanted', () => {
  assert.equal(stockPhotoWanted(undefined, {}), true);
  assert.equal(stockPhotoWanted({ featuredImage: 'insights-only' }, { category: 'Business' }), false);
  assert.equal(stockPhotoWanted({ featuredImage: 'insights-only' }, { category: INSIGHT_CATEGORY }), true);
});

test('stockPhotoWanted: a cover site with no setting wants no stock photo for any post', () => {
  assert.equal(stockPhotoWanted({ dir: 'src/blog' }, { category: INSIGHT_CATEGORY, hasCover: true }), false);
  assert.equal(stockPhotoWanted(undefined, { hasCover: true }), false);
});

test("stockPhotoWanted: cover site + 'insights-only' -> Pexels for Insights only, gradient for the rest", () => {
  const target = { featuredImage: 'insights-only' };
  assert.equal(stockPhotoWanted(target, { category: INSIGHT_CATEGORY, hasCover: true }), true);
  assert.equal(stockPhotoWanted(target, { category: 'AI Fundamentals', hasCover: true }), false);
  assert.equal(stockPhotoWanted(target, { hasCover: true }), false);
});
