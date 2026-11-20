import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiresHumanReview, riskTierForGenerator } from './risk-tiers.js';

test('trend-radar content needs a person\'s approval by default (suspended unattended publishing, 2026-11-20)', () => {
  delete process.env.TREND_RADAR_REQUIRE_REVIEW;
  delete process.env.TREND_RADAR_AUTO_PUBLISH;
  assert.equal(riskTierForGenerator('blog-outline'), 'safe'); // the generator's own tier is unchanged
  assert.equal(requiresHumanReview({ source: 'trend-radar' }), true);
  assert.equal(requiresHumanReview({ source: 'content-gap' }), false); // other blog sources are unaffected
});

test('TREND_RADAR_AUTO_PUBLISH=true is the explicit opt-in that restores unattended trend posts', () => {
  delete process.env.TREND_RADAR_REQUIRE_REVIEW;
  process.env.TREND_RADAR_AUTO_PUBLISH = 'true';
  try {
    assert.equal(requiresHumanReview({ source: 'trend-radar' }), false);
    // and the older switch still wins if someone sets both
    process.env.TREND_RADAR_REQUIRE_REVIEW = 'true';
    assert.equal(requiresHumanReview({ source: 'trend-radar' }), true);
  } finally { delete process.env.TREND_RADAR_AUTO_PUBLISH; delete process.env.TREND_RADAR_REQUIRE_REVIEW; }
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
