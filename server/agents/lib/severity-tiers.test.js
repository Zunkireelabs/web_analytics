import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { severityTierFor, severityTierLabel, SEVERITY_TIER, DEFAULT_TIER } from './severity-tiers.js';

describe('severity-tiers', () => {
  test('critical technical / indexing generators rank tier 1', () => {
    for (const gen of ['canonical', 'robots-fix', 'sitemap', 'broken-link-fix', 'schema-repair', 'duplicate-id-fix']) {
      assert.equal(severityTierFor(gen), SEVERITY_TIER.CRITICAL_TECHNICAL, gen);
    }
  });

  test('high-impact on-page generators rank tier 2', () => {
    for (const gen of ['meta-title', 'schema', 'faq', 'internal-links']) {
      assert.equal(severityTierFor(gen), SEVERITY_TIER.ON_PAGE, gen);
    }
  });

  test('search-backed expansion ranks tier 3, net-new content tier 4, cosmetic tier 5', () => {
    assert.equal(severityTierFor('expand-content'), SEVERITY_TIER.EXPANSION);
    assert.equal(severityTierFor('blog-outline'), SEVERITY_TIER.CONTENT);
    assert.equal(severityTierFor('alt-text'), SEVERITY_TIER.CLEANUP);
  });

  test('an unrecognized generator falls to the ON_PAGE default, never to critical', () => {
    assert.equal(severityTierFor('some-future-generator'), DEFAULT_TIER);
    assert.equal(DEFAULT_TIER, SEVERITY_TIER.ON_PAGE);
  });

  test('the tier hierarchy is strictly ordered 1 (most critical) through 5', () => {
    assert.ok(SEVERITY_TIER.CRITICAL_TECHNICAL < SEVERITY_TIER.ON_PAGE);
    assert.ok(SEVERITY_TIER.ON_PAGE < SEVERITY_TIER.EXPANSION);
    assert.ok(SEVERITY_TIER.EXPANSION < SEVERITY_TIER.CONTENT);
    assert.ok(SEVERITY_TIER.CONTENT < SEVERITY_TIER.CLEANUP);
  });

  test('severityTierLabel is a stable, readable name for every tier', () => {
    assert.equal(severityTierLabel('canonical'), 'critical-technical');
    assert.equal(severityTierLabel('meta-title'), 'on-page');
    assert.equal(severityTierLabel('expand-content'), 'expansion');
    assert.equal(severityTierLabel('blog-outline'), 'content');
    assert.equal(severityTierLabel('alt-text'), 'cleanup');
  });
});
