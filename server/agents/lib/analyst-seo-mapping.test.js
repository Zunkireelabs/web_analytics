import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { seoDraftEligibility, opportunityDraftEligibility, gapDraftEligibility, requestedBlogEligibility } from './analyst-seo-mapping.js';

// Regression coverage for the audit finding this module had NO test file at
// all — the one place a Node/Python drift in generator selection would
// surface silently (see app/investigations/drafts.py's own docstring:
// "MUST mirror server/agents/lib/analyst-seo-mapping.js::
// generatorForDecliningPage exactly ... If the two subsystems picked
// different generators for the same finding, whichever one drafts first
// would silently and permanently suppress the other, correct one").
// data-analyst-agent/tests/investigations/test_drafts.py already pins the
// Python side's mapping for the same four metrics; this is the Node-side
// counterpart, so an edit to either side without the other is caught by
// its own language's test suite, not just by reading the comment.
const site = { id: 1, website_domain: 'example.com' };

function decline({ metricKey = 'gsc_impressions', dimensionValue = 'https://example.com/page' } = {}) {
  return {
    metric_key: metricKey, insight_type: 'trend_shift', dimension_type: 'page',
    dimension_value: dimensionValue, period_start: '2026-08-18',
    evidence: { pct_change: -30 },
  };
}

describe('seoDraftEligibility — generator mapping (must stay in parity with drafts.py::_generator_for_declining_page)', () => {
  test('gsc_ctr decline -> meta-title, with query set to the page dimension value', () => {
    const action = seoDraftEligibility(site, decline({ metricKey: 'gsc_ctr' }));
    assert.equal(action.generatorId, 'meta-title');
    assert.deepEqual(action.params, { page: 'https://example.com/page', query: 'https://example.com/page' });
  });

  test('gsc_clicks decline -> meta-title, same as gsc_ctr', () => {
    const action = seoDraftEligibility(site, decline({ metricKey: 'gsc_clicks' }));
    assert.equal(action.generatorId, 'meta-title');
  });

  test('gsc_position decline -> qa-content', () => {
    const action = seoDraftEligibility(site, decline({ metricKey: 'gsc_position' }));
    assert.equal(action.generatorId, 'qa-content');
    assert.deepEqual(action.params, { page: 'https://example.com/page' });
  });

  test('gsc_impressions decline (and any other gsc_* metric) -> expand-content', () => {
    const action = seoDraftEligibility(site, decline({ metricKey: 'gsc_impressions' }));
    assert.equal(action.generatorId, 'expand-content');
    assert.deepEqual(action.params, { page: 'https://example.com/page' });
  });

  test('finding_id is deterministic and matches the exact template drafts.py::_eligibility builds', () => {
    const insight = decline({ metricKey: 'gsc_position' });
    const action = seoDraftEligibility(site, insight);
    assert.equal(action.findingId, 'analyst:gsc_position:trend_shift:2026-08-18:https://example.com/page');
  });

  test('a relative dimension_value is resolved against the site\'s own domain', () => {
    const action = seoDraftEligibility(site, decline({ dimensionValue: '/blog/post' }));
    assert.equal(action.page, 'https://example.com/blog/post');
  });
});

describe('seoDraftEligibility — eligibility gates', () => {
  test('non-gsc metric is not eligible', () => {
    assert.equal(seoDraftEligibility(site, decline({ metricKey: 'ga4_sessions' })), null);
  });

  test('site-dimension (not page-dimension) insight is not eligible', () => {
    const insight = { ...decline(), dimension_type: 'site' };
    assert.equal(seoDraftEligibility(site, insight), null);
  });

  test('an improvement (positive pct_change) is not eligible — only declines trigger', () => {
    const insight = { ...decline(), evidence: { pct_change: 20 } };
    assert.equal(seoDraftEligibility(site, insight), null);
  });

  test('a forecast_risk insight is eligible by definition, regardless of evidence', () => {
    const insight = { ...decline(), insight_type: 'forecast_risk', evidence: {} };
    assert.notEqual(seoDraftEligibility(site, insight), null);
  });
});

// GSC's page dimension is documented to return full absolute URLs — the
// insight's own page can legitimately be on ANY hostname the GSC property
// covers, including a registered-but-separate additional_own_domain or a
// foreign one entirely. Gap confirmed 2026-08-24: this bridge created a real
// recommendation for such pages with no domain check at all.
describe('seoDraftEligibility — domain scoping (only the site\'s own primary domain)', () => {
  test('an insight on the site\'s own primary domain is eligible, as before', () => {
    assert.notEqual(seoDraftEligibility(site, decline({ dimensionValue: 'https://example.com/page' })), null);
  });

  test('an insight on a registered additional_own_domain (a separate product) is NOT eligible', () => {
    const multiDomainSite = { ...site, additional_own_domains: ['edgex.example.com'] };
    const insight = decline({ dimensionValue: 'https://edgex.example.com/page' });
    assert.equal(seoDraftEligibility(multiDomainSite, insight), null);
  });

  test('an insight on a completely foreign hostname is NOT eligible', () => {
    const insight = decline({ dimensionValue: 'https://some-other-site.com/page' });
    assert.equal(seoDraftEligibility(site, insight), null);
  });

  test('a relative dimension_value (resolved against the site\'s own domain by absolutePageUrl) is still eligible', () => {
    assert.notEqual(seoDraftEligibility(site, decline({ dimensionValue: '/blog/post' })), null);
  });

  test('no website_domain configured passes through unfiltered — never risks excluding the site\'s own real pages on an unset config', () => {
    const unscopedSite = { id: 1 };
    const insight = decline({ dimensionValue: 'https://anything.example.com/page' });
    assert.notEqual(seoDraftEligibility(unscopedSite, insight), null);
  });
});

// Regression coverage for the audit finding this function (added alongside
// AnalystGrowthOpportunities.jsx's "Send to Action Center" button for the
// four opportunity types that were never eligible for
// createActionCenterRecommendationForGap, which only ever handles
// content-gap) had no test file at all.
function opp({ type = 'quick-win', page = 'https://example.com/page', query = 'some query' } = {}) {
  return { type, page, query };
}

describe('opportunityDraftEligibility — generator mapping', () => {
  test('quick-win -> meta-title, with query carried through (a CTR/presentation problem)', () => {
    const action = opportunityDraftEligibility(site, opp({ type: 'quick-win', query: 'best widgets' }));
    assert.equal(action.generatorId, 'meta-title');
    assert.deepEqual(action.params, { page: 'https://example.com/page', query: 'best widgets' });
  });

  for (const type of ['page1-opportunity', 'content-expansion']) {
    test(`${type} -> expand-content (a coverage/depth problem, no query needed)`, () => {
      const action = opportunityDraftEligibility(site, opp({ type }));
      assert.equal(action.generatorId, 'expand-content');
      assert.deepEqual(action.params, { page: 'https://example.com/page' });
    });
  }

  test('declining -> refresh-content (a staleness problem on a page that already had traffic), carrying the real trend evidence', () => {
    const trend = { priorClicks: 40, recentClicks: 10, priorPosition: 3, recentPosition: 6, dropPct: 75 };
    const action = opportunityDraftEligibility(site, { ...opp({ type: 'declining', query: 'widgets' }), trend });
    assert.equal(action.generatorId, 'refresh-content');
    assert.deepEqual(action.params, { page: 'https://example.com/page', query: 'widgets', trend });
  });

  test('finding_id is deterministic per (type, page, query)', () => {
    const action = opportunityDraftEligibility(site, opp({ type: 'quick-win', query: 'best widgets' }));
    assert.equal(action.findingId, 'growth-opportunity:quick-win:https://example.com/page:best widgets');
  });

  test('a missing query still produces a stable finding_id (empty string, not "undefined")', () => {
    const action = opportunityDraftEligibility(site, opp({ type: 'page1-opportunity', query: null }));
    assert.equal(action.findingId, 'growth-opportunity:page1-opportunity:https://example.com/page:');
  });
});

describe('opportunityDraftEligibility — eligibility gates', () => {
  test('content-gap is NOT eligible here — it has its own approval path (createActionCenterRecommendationForGap)', () => {
    assert.equal(opportunityDraftEligibility(site, opp({ type: 'content-gap' })), null);
  });

  test('an unknown/future opportunity type is not eligible rather than guessing a generator', () => {
    assert.equal(opportunityDraftEligibility(site, opp({ type: 'something-new' })), null);
  });

  test('no page (e.g. a query with no landing page recorded) is not eligible — nothing to draft against', () => {
    assert.equal(opportunityDraftEligibility(site, opp({ page: null })), null);
  });

  test('a page on a registered additional_own_domain is NOT eligible — same primary-domain-only scoping as seoDraftEligibility', () => {
    const multiDomainSite = { ...site, additional_own_domains: ['edgex.example.com'] };
    assert.equal(opportunityDraftEligibility(multiDomainSite, opp({ page: 'https://edgex.example.com/page' })), null);
  });

  test('a page on a completely foreign hostname is NOT eligible', () => {
    assert.equal(opportunityDraftEligibility(site, opp({ page: 'https://some-other-site.com/page' })), null);
  });
});

describe('gapDraftEligibility', () => {
  const gap = (overrides = {}) => ({ id: 1, topic: 'best crm software', priority: 'medium', ...overrides });

  test('a malformed gap (no id or topic) is not eligible', () => {
    assert.equal(gapDraftEligibility({ topic: 'x' }), null);
    assert.equal(gapDraftEligibility({ id: 1 }), null);
  });

  test('already covered by an existing page, non-question shape -> nothing to draft (the page already covers it)', () => {
    assert.equal(gapDraftEligibility(gap({ existing_page_match: 'https://example.com/crm' })), null);
  });

  test('already covered by an existing page, QUESTION shape -> a real FAQ opportunity, not nothing', () => {
    const action = gapDraftEligibility(gap({ topic: 'how does crm software work', existing_page_match: 'https://example.com/crm' }));
    assert.equal(action.generatorId, 'faq');
    assert.equal(action.existingPage, 'https://example.com/crm');
  });

  test('unrelated + informational + low priority -> a real "do nothing" outcome', () => {
    assert.equal(gapDraftEligibility(gap({ product_relevance: 'unrelated', search_intent: 'informational', priority: 'low' })), null);
  });

  test('a comparison-shaped topic is eligible but flagged as requiring future infrastructure, never silently drafted as something it isn\'t', () => {
    const action = gapDraftEligibility(gap({ topic: 'zunkiree vs competitor' }));
    assert.equal(action.eligible, true);
    assert.equal(action.requiresFutureInfrastructure, true);
    assert.ok(!action.generatorId);
  });

  test('commercial/transactional intent + direct product relevance -> landing-page', () => {
    const action = gapDraftEligibility(gap({ search_intent: 'commercial', product_relevance: 'direct' }));
    assert.equal(action.generatorId, 'landing-page');
  });

  test('everything else -> blog-outline, the default', () => {
    const action = gapDraftEligibility(gap({ search_intent: 'informational', product_relevance: 'supporting' }));
    assert.equal(action.generatorId, 'blog-outline');
  });

  test('a question-shaped topic with no existing page carries a shapeHint for whichever generator was picked', () => {
    const action = gapDraftEligibility(gap({ topic: 'how does crm software work' }));
    assert.match(action.shapeHint, /QUESTION-phrased/);
  });
});

// The Analyst page's "Write a blog post on this topic?" Yes. Every case below
// is one gapDraftEligibility would route somewhere that never produces a blog
// in tomorrow's run — the whole reason this override exists.
describe('requestedBlogEligibility', () => {
  const gap = (overrides = {}) => ({ id: 1, topic: 'best crm software', priority: 'medium', ...overrides });

  test('a malformed gap is still not eligible — an explicit ask cannot conjure a topic', () => {
    assert.equal(requestedBlogEligibility({ topic: 'x' }), null);
    assert.equal(requestedBlogEligibility({ id: 1 }), null);
  });

  test('a commercial/direct topic becomes a blog, not the manual-tier landing-page the daily run would never ship', () => {
    assert.equal(gapDraftEligibility(gap({ search_intent: 'commercial', product_relevance: 'direct' })).generatorId, 'landing-page');
    assert.equal(requestedBlogEligibility(gap({ search_intent: 'commercial', product_relevance: 'direct' })).generatorId, 'blog-outline');
  });

  test('a comparison-shaped topic becomes a blog rather than the comparison-page type no generator can draft', () => {
    const action = requestedBlogEligibility(gap({ topic: 'zunkiree vs competitor' }));
    assert.equal(action.generatorId, 'blog-outline');
    assert.ok(!action.requiresFutureInfrastructure);
  });

  test('a question about an already-covered page becomes a blog, not an FAQ spliced into that page', () => {
    const covered = { topic: 'how does crm software work', existing_page_match: 'https://example.com/crm' };
    assert.equal(gapDraftEligibility(gap(covered)).generatorId, 'faq');
    assert.equal(requestedBlogEligibility(gap(covered)).generatorId, 'blog-outline');
  });

  test('a topic gapDraftEligibility would decline entirely still gets its blog — the human already decided', () => {
    const declined = { product_relevance: 'unrelated', search_intent: 'informational', priority: 'low' };
    assert.equal(gapDraftEligibility(gap(declined)), null);
    assert.equal(requestedBlogEligibility(gap(declined)).generatorId, 'blog-outline');
  });

  test('the question shapeHint survives the override — it is good guidance for the article either way', () => {
    assert.match(requestedBlogEligibility(gap({ topic: 'how does crm software work' })).shapeHint, /QUESTION-phrased/);
  });
});
