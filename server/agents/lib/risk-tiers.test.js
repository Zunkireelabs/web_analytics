import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiresHumanReview, riskTierForGenerator } from './risk-tiers.js';

test('trend-radar insight drafts ship unattended, like any other blog-outline', () => {
  delete process.env.TREND_RADAR_REQUIRE_REVIEW;
  assert.equal(riskTierForGenerator('blog-outline'), 'safe');
  assert.equal(requiresHumanReview({ source: 'trend-radar' }), false);
});

test('TREND_RADAR_REQUIRE_REVIEW=true restores always-review for trend posts, without a deploy', () => {
  process.env.TREND_RADAR_REQUIRE_REVIEW = 'true';
  try {
    assert.equal(requiresHumanReview({ source: 'trend-radar' }), true);
    // and nothing else is affected by the switch
    assert.equal(requiresHumanReview({ source: 'content-gap' }), false);
  } finally { delete process.env.TREND_RADAR_REQUIRE_REVIEW; }
});

test('the other human-review rules are untouched by the trend-radar change', () => {
  assert.equal(requiresHumanReview({ source: 'geo-signals' }), true);
  assert.equal(requiresHumanReview({ params: { fixType: 'typography-drift-heading' } }), true);
});

test('other blog-outline sources are unaffected', () => {
  assert.equal(requiresHumanReview({ source: 'content-gap' }), false);
  assert.equal(requiresHumanReview({ source: 'comparison-opportunity' }), false);
});
