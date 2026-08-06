import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recommendationPageKey } from './recommendation-coordinator.js';

// Regression coverage for a real report: trust-compliance.js's 'missing'
// variant of a cookie/privacy/terms finding has no real page (params.page
// stays null), but its 'broken' variant does (the dead link's own target) —
// same underlying document, different `page` value depending on which
// status a given run happened to observe. Before this fix, that produced
// two permanently-separate "Draft X" cards once the status flipped between
// two runs.
describe('recommendationPageKey — site-level generators collapse to one key', () => {
  test('cookie-policy/privacy-policy/terms-of-service always key on empty string, regardless of a real page/href', () => {
    for (const generatorId of ['cookie-policy', 'privacy-policy', 'terms-of-service']) {
      assert.equal(recommendationPageKey({ generatorId, params: { page: null } }), '');
      assert.equal(recommendationPageKey({ generatorId, params: { page: 'https://example.com/terms/' } }), '');
    }
  });

  test('llms-txt/security-headers/html-lang/sitemap/robots-fix also collapse to one key', () => {
    for (const generatorId of ['llms-txt', 'security-headers', 'html-lang', 'sitemap', 'robots-fix']) {
      assert.equal(recommendationPageKey({ generatorId, params: { page: 'https://example.com/anything' } }), '');
    }
  });

  test('a normal per-page generator (meta-title) still keys on its real page', () => {
    assert.equal(recommendationPageKey({ generatorId: 'meta-title', params: { page: 'https://example.com/a' } }), 'https://example.com/a');
    assert.equal(recommendationPageKey({ generatorId: 'meta-title', params: {} }), '');
  });
});

// Regression coverage for a real bug this same change fixes on the way in:
// GA4 and Facebook Pixel findings both use generatorId 'analytics-install'
// AND the same page (the homepage) — without a provider discriminator in
// the key, they'd collide into one recommendation row and one of the two
// providers would silently vanish from Recommendations forever.
describe('recommendationPageKey — analytics-install keys by provider, not page', () => {
  test('GA4 and Facebook Pixel produce distinct keys despite sharing generatorId and page', () => {
    const ga4Key = recommendationPageKey({ generatorId: 'analytics-install', params: { provider: 'ga4', page: 'https://example.com/' } });
    const fbKey = recommendationPageKey({ generatorId: 'analytics-install', params: { provider: 'facebook-pixel', page: 'https://example.com/' } });
    assert.notEqual(ga4Key, fbKey);
  });
});
