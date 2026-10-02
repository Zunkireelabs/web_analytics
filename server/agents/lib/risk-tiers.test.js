import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiresHumanReview, riskTierForGenerator } from './risk-tiers.js';

test('trend-radar insight drafts always need a human, though blog-outline itself stays safe-tier', () => {
  assert.equal(riskTierForGenerator('blog-outline'), 'safe');
  assert.equal(requiresHumanReview({ source: 'trend-radar' }), true);
});

test('other blog-outline sources are unaffected', () => {
  assert.equal(requiresHumanReview({ source: 'content-gap' }), false);
  assert.equal(requiresHumanReview({ source: 'comparison-opportunity' }), false);
});
