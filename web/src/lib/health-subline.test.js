import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { healthSubline } from './health-subline.js';

describe('healthSubline', () => {
  test('names the category losing the most and its share', () => {
    assert.equal(healthSubline({ breakdown: [{ category: 'security', share: 0.46 }, { category: 'seo', share: 0.4 }] }), '46% of the loss is in Security');
    assert.equal(healthSubline({ breakdown: [{ category: 'accessibility', share: 0.5 }, { category: 'seo', share: 0.5 }] }), '50% of the loss is in Accessibility');
  });
  test('one category only: says so rather than "100%"', () => assert.equal(healthSubline({ breakdown: [{ category: 'seo', share: 1 }] }), 'Open issues are all in SEO'));
  test('an unknown category is shown as it is; no data or an older server keeps the original caption', () => {
    assert.equal(healthSubline({ breakdown: [{ category: 'brand-new', share: 0.7 }, { category: 'seo', share: 0.3 }] }), '70% of the loss is in brand-new');
    for (const h of [undefined, null, {}, { breakdown: [] }, { breakdown: 'nope' }]) assert.equal(healthSubline(h), 'Weighted across all agents');
  });
});
