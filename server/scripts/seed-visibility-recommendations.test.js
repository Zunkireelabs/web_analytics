import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS, buildRecommendation, AGENT } from './seed-visibility-recommendations.js';
import { severityTierFor, SEVERITY_TIER } from '../agents/lib/severity-tiers.js';
import { VISIBILITY_TYPES } from '../agents/lib/growth-scoring.js';

describe('seed-visibility-recommendations', () => {
  test('the five agreed fixes, each on its own project', () => {
    assert.deepEqual(ITEMS.map((i) => [i.siteId, i.type]), [
      [8864, 'meta-title'], [8872, 'meta-title'], [8874, 'meta-title'], [8871, 'faq'], [8872, 'blog-outline'],
    ]);
    for (const i of ITEMS) assert.equal(new URL(i.page).protocol, 'https:');
  });

  test('title and FAQ fixes are safe on-page work the visibility-first queue ranks up', () => {
    for (const item of ITEMS.filter((i) => i.type !== 'blog-outline')) {
      const r = buildRecommendation(item);
      assert.ok(VISIBILITY_TYPES.has(r.recommendationType));
      assert.equal(severityTierFor(r.recommendationType), SEVERITY_TIER.ON_PAGE);
      assert.equal(r.riskTier, 'safe');
      assert.equal(r.detectingAgent, AGENT);
      assert.equal(r.params.page, item.page);
    }
  });

  test('the customer post needs a person\'s approval first, stricter than the platform default', () => {
    const post = buildRecommendation(ITEMS.find((i) => i.type === 'blog-outline'));
    assert.equal(post.riskTier, 'manual');
    assert.match(post.params.topic, /Nuad Thai Spa/);
  });

  test('the post is limited to the confirmed facts and forbids the unconfirmed ones', () => {
    const { context } = buildRecommendation(ITEMS.find((i) => i.type === 'blog-outline')).params;
    assert.match(context, /Lazimpat, Kathmandu/);
    assert.match(context, /Do NOT state branch, therapist or service counts/);
  });

  test('the FAQ carries the real SuperRank figures, not the stale listing', () => {
    const r = buildRecommendation(ITEMS.find((i) => i.type === 'faq'));
    assert.equal(r.params.topic, 'Is SuperRank the same as Suparank?');
    assert.match(r.reason, /40\+ checks/);
    assert.match(r.reason, /\$95/);
    assert.doesNotMatch(r.reason, /63|49\.99/);
  });

  test('one stable finding id per fix, so a re-run can never duplicate', () => {
    const ids = ITEMS.map((i) => buildRecommendation(i).findingId);
    assert.equal(new Set(ids).size, ITEMS.length);
    assert.deepEqual(ids, ITEMS.map((i) => buildRecommendation(i).findingId));
  });

  test('wording keeps to the confirmed facts', () => {
    const text = ITEMS.map((i) => i.reason).join(' ');
    assert.match(text, /Chayce Properties/);
    assert.match(text, /Bangalore/);
    assert.doesNotMatch(text, /study abroad partner in Nepal/i);
  });
});
