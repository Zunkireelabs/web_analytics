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

// Regression coverage for a real report: geo-signals.js raises up to 4
// independent findings for the same page under generatorId 'expand-content'
// (author-byline, freshness-date, comparison-content, external-citations —
// GEO_SIGNAL_RULES), each with its own non-interchangeable params.focus.
// Without a discriminator here they collided into one recommendation row:
// `issue` froze on whichever focus inserted first, `params` kept getting
// overwritten by whichever focus synced last (mergeIntoRecommendation's
// `params = COALESCE($5, params)`) — so a card could display the
// author-byline label while its params silently held external-citations,
// and clicking Generate ran the wrong focus and surfaced a citation-search
// error under an author-byline heading.
describe('recommendationPageKey — expand-content keys by focus, not just page', () => {
  test('the 4 GEO-signal focuses produce 4 distinct keys despite sharing generatorId and page', () => {
    const page = 'https://example.com/a';
    const keys = ['author-byline', 'freshness-date', 'comparison-content', 'external-citations']
      .map((focus) => recommendationPageKey({ generatorId: 'expand-content', params: { page, focus } }));
    assert.equal(new Set(keys).size, keys.length);
  });
});

// Regression coverage for a real report: `params.page` on a broken-link-fix
// finding is only the FIRST page a dead href happened to be crawled from
// (c.sourcePages[0]), so two unrelated dead links first seen on the same
// page (e.g. a shared footer/nav template) collided into one recommendation
// row. Confirmed as a real report: a site with 4 distinct verified broken
// links showed only 1 in the Action Center. `href` is the real identity of
// a broken-link-fix recommendation, not the page it was first seen on.
describe('recommendationPageKey — broken-link-fix keys by href, not just page', () => {
  test('two dead links first crawled from the same page produce distinct keys', () => {
    const page = 'https://example.com/a';
    const keyA = recommendationPageKey({ generatorId: 'broken-link-fix', params: { page, href: 'https://example.com/dead-1' } });
    const keyB = recommendationPageKey({ generatorId: 'broken-link-fix', params: { page, href: 'https://example.com/dead-2' } });
    assert.notEqual(keyA, keyB);
  });
});

// Regression coverage for a real report: blog-outline findings have no
// params.page at all (net-new content, not tied to an existing page), only
// params.topic. Both content-gap.js and ai-recommendation.js raise
// blog-outline findings, so without a discriminator here every one of them
// collapses to the same page='' key and a second distinct topic silently
// disappears into finding_ids on whichever topic synced first. `topic` is
// the real identity of a blog-outline recommendation, the same way `href`
// is for broken-link-fix above.
describe('recommendationPageKey — blog-outline keys by topic, not page', () => {
  test('two distinct topics produce distinct keys, and neither collapses to the site-level empty key', () => {
    const keyA = recommendationPageKey({ generatorId: 'blog-outline', params: { topic: 'How to choose a moving company' } });
    const keyB = recommendationPageKey({ generatorId: 'blog-outline', params: { topic: 'Long-distance moving checklist' } });
    assert.notEqual(keyA, keyB);
    assert.notEqual(keyA, '');
    assert.notEqual(keyB, '');
  });
});

// visual-quality.js can flag more than one independent defect (e.g. a
// malformed-table AND a duplicate-faq) on the SAME page in one run — without
// fixType in the key, both would collide onto the same recommendations row
// and the second one would silently disappear into finding_ids, same
// failure mode as analytics-install/expand-content/broken-link-fix above.
describe('recommendationPageKey — content-integrity-repair keys by fixType too, not just page', () => {
  test('two distinct fixTypes on the same page produce distinct keys', () => {
    const page = 'https://example.com/pricing';
    const keyA = recommendationPageKey({ generatorId: 'content-integrity-repair', params: { page, fixType: 'malformed-table' } });
    const keyB = recommendationPageKey({ generatorId: 'content-integrity-repair', params: { page, fixType: 'duplicate-faq' } });
    assert.notEqual(keyA, keyB);
  });

  test('the same page+fixType still produces the same key (real dedup preserved)', () => {
    const params = { page: 'https://example.com/pricing', fixType: 'malformed-table' };
    const keyA = recommendationPageKey({ generatorId: 'content-integrity-repair', params });
    const keyB = recommendationPageKey({ generatorId: 'content-integrity-repair', params: { ...params } });
    assert.equal(keyA, keyB);
  });
});
