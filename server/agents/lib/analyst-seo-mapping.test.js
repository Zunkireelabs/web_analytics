import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { seoDraftEligibility, opportunityDraftEligibility, gapDraftEligibility, requestedBlogEligibility, requestedLandingEligibility, recommendedActionForGap, groundingNote, competitorGroundingNote, blockedPlacementForGap } from './analyst-seo-mapping.js';

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
    // a DECLINE in this metric's own direction: for search position a higher number is a worse ranking, so its decline is a
    // RISE (this helper used -30 for every metric, which for position was an improvement; see lib/metric-direction.js)
    evidence: { pct_change: metricKey === 'gsc_position' ? 30 : -30 },
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

// The Keywords page's "Landing page" choice: whatever the person picked is what gets created.
describe('requestedLandingEligibility', () => {
  const gap = (overrides = {}) => ({ id: 1, topic: 'salon booking software', priority: 'medium', ...overrides });

  test('a malformed gap is not eligible', () => {
    assert.equal(requestedLandingEligibility({ topic: 'x' }), null);
    assert.equal(requestedLandingEligibility({ id: 1 }), null);
  });
  test('an informational topic the classifier would make a blog is still a landing page when chosen', () => {
    const g = gap({ search_intent: 'informational', product_relevance: 'supporting' });
    assert.equal(gapDraftEligibility(g).generatorId, 'blog-outline');
    assert.equal(requestedLandingEligibility(g).generatorId, 'landing-page');
  });
  test('its finding id differs from the blog one, so a blog and a landing page for one keyword cannot collide', () => {
    assert.notEqual(requestedLandingEligibility(gap()).findingId, requestedBlogEligibility(gap()).findingId);
  });
  test('a topic gapDraftEligibility would decline entirely still gets its page, the person already decided', () => {
    const declined = { product_relevance: 'unrelated', search_intent: 'informational', priority: 'low' };
    assert.equal(gapDraftEligibility(gap(declined)), null);
    assert.equal(requestedLandingEligibility(gap(declined)).generatorId, 'landing-page');
  });
});

describe('coverage verdicts drive eligibility and the action shown to a human', () => {
  const gap = (over = {}) => ({ id: 5, topic: 'enterprise software development', priority: 'medium', search_intent: 'informational', product_relevance: 'supporting', ...over });

  test('duplicate -> nothing to draft', () => {
    assert.equal(gapDraftEligibility(gap({ coverage_status: 'duplicate' })), null);
    assert.equal(recommendedActionForGap(gap({ coverage_status: 'duplicate' })).kind, 'none');
  });

  test('uncertain -> never auto-drafted, but visible as "review"', () => {
    assert.equal(gapDraftEligibility(gap({ coverage_status: 'uncertain' })), null);
    assert.equal(recommendedActionForGap(gap({ coverage_status: 'uncertain', coverage_reason: 'Partial overlap' })).kind, 'review');
  });

  test('a keyword in another language is never drafted into the default-language collection', () => {
    assert.equal(gapDraftEligibility(gap({ language_code: 'de', coverage_status: 'opportunity' })), null);
    assert.equal(recommendedActionForGap(gap({ language_code: 'de', coverage_status: 'opportunity' })).kind, 'localize');
  });

  test('language_gap -> a visible "localize" action, not a blog draft', () => {
    const a = recommendedActionForGap(gap({ coverage_status: 'language_gap', language_code: 'de' }));
    assert.equal(a.kind, 'localize');
    assert.match(a.label, /Localize/);
  });

  test('market_gap is a REAL opportunity: drafted, with market grounding that forbids the country-swap failure', () => {
    const e = gapDraftEligibility(gap({ coverage_status: 'market_gap', coverage_evidence: { gapMarkets: ['GB'] } }));
    assert.equal(e.eligible, true);
    assert.equal(e.generatorId, 'blog-outline');
    assert.match(e.shapeHint, /Target market: United Kingdom/);
    assert.match(e.shapeHint, /Do not present companies from other countries as competitors/);
  });

  test('intent_gap is a real opportunity and follows the keyword intent (commercial + direct -> landing page)', () => {
    const e = gapDraftEligibility(gap({ coverage_status: 'intent_gap', search_intent: 'commercial', product_relevance: 'direct' }));
    assert.equal(e.generatorId, 'landing-page');
  });

  test('covered: a question gets an FAQ on the covering page, anything else gets nothing', () => {
    const covered = { coverage_status: 'covered', existing_page_match: 'https://example.com/services/x/' };
    assert.equal(gapDraftEligibility(gap({ ...covered, topic: 'what is x' })).generatorId, 'faq');
    assert.equal(gapDraftEligibility(gap({ ...covered, topic: 'x services' })), null);
  });

  test('the action label reflects what will really happen, not always "blog post"', () => {
    assert.equal(recommendedActionForGap(gap({ coverage_status: 'opportunity' })).kind, 'blog-post');
    assert.equal(recommendedActionForGap(gap({ coverage_status: 'opportunity', search_intent: 'commercial', product_relevance: 'direct' })).kind, 'landing-page');
    const faq = recommendedActionForGap(gap({ topic: 'what is x', coverage_status: 'covered', existing_page_match: 'https://example.com/a/' }));
    assert.equal(faq.kind, 'faq');
    assert.equal(faq.page, 'https://example.com/a/');
    assert.equal(recommendedActionForGap(gap({ coverage_status: 'covered', existing_page_match: 'https://example.com/a/' })).kind, 'none');
  });

  test('a covered/duplicate page flagged stale is a REFRESH, never a new year-swapped page', () => {
    const a = recommendedActionForGap(gap({ coverage_status: 'covered', existing_page_match: 'https://example.com/b/', coverage_evidence: { needsRefresh: true, staleReason: 'Page is dated 2024.' } }));
    assert.equal(a.kind, 'refresh');
  });

  test('every draft is told the current year and to state no unprovided facts', () => {
    const note = groundingNote({}, new Date('2027-03-01'));
    assert.match(note, /Current year: 2027/);
    assert.match(note, /Never put an older year/);
  });

  test('legacy rows with no coverage verdict behave exactly as before', () => {
    assert.equal(gapDraftEligibility(gap({ existing_page_match: 'https://example.com/a/' })), null);
    assert.equal(gapDraftEligibility(gap({})).generatorId, 'blog-outline');
  });
});

// --- Phase 5: competitor evidence changes what to do about a gap (migration 234) ---
// The existing answers for every gap WITHOUT competitor evidence must be byte-for-byte unchanged; that is what the
// first test here protects. The rest protect the one new behaviour: an existing page plus measured rival evidence is
// a page to strengthen, not a second page to write.
describe('gapDraftEligibility with competitor evidence', () => {
  const base = { id: 7, topic: 'teeth whitening cost', product_relevance: 'direct', search_intent: 'commercial' };
  const evidence = { competitors: [{ domain: 'rival.com', position: 3 }], ourPosition: 18 };

  test('a gap with an existing page and NO competitor evidence is still "nothing to draft"', () => {
    assert.equal(gapDraftEligibility({ ...base, existing_page_match: 'https://ours.com/whitening' }), null);
  });

  test('an improve_page opportunity on an existing page routes to expand-content', () => {
    const e = gapDraftEligibility({
      ...base, existing_page_match: 'https://ours.com/whitening',
      opportunity_type: 'improve_page', competitor_evidence: evidence,
    });
    assert.equal(e.generatorId, 'expand-content');
    assert.equal(e.existingPage, 'https://ours.com/whitening');
    assert.match(e.shapeHint, /rival\.com \(position 3\)/);
  });

  test('a position_gap on an existing page also strengthens that page', () => {
    const e = gapDraftEligibility({
      ...base, existing_page_match: 'https://ours.com/whitening',
      opportunity_type: 'position_gap', competitor_evidence: evidence,
    });
    assert.equal(e.generatorId, 'expand-content');
  });

  test('a question-shaped topic on an existing page is still an FAQ, evidence or not', () => {
    const e = gapDraftEligibility({
      ...base, topic: 'how much does teeth whitening cost', existing_page_match: 'https://ours.com/whitening',
      opportunity_type: 'improve_page', competitor_evidence: evidence,
    });
    assert.equal(e.generatorId, 'faq');
  });

  test('a service_location opportunity is a landing page even when the intent reads informational', () => {
    const e = gapDraftEligibility({
      ...base, topic: 'teeth whitening pokhara', search_intent: 'informational', product_relevance: 'supporting',
      opportunity_type: 'service_location', competitor_evidence: evidence,
    });
    assert.equal(e.generatorId, 'landing-page');
  });

  test('the grounding note forbids copying rivals and repeating their claims', () => {
    const e = gapDraftEligibility({ ...base, opportunity_type: 'missing', competitor_evidence: evidence });
    assert.match(e.shapeHint, /Do not copy their structure or wording/);
    assert.match(e.shapeHint, /do not repeat any claim/);
    assert.match(e.shapeHint, /We currently rank 18/);
  });

  test('evidence with no usable competitor rows adds no note', () => {
    for (const ev of [null, {}, { competitors: [] }, { competitors: [{ domain: null, position: 3 }] }]) {
      assert.equal(competitorGroundingNote({ ...base, competitor_evidence: ev }), null);
    }
  });

  test('a rival page is never quoted into the note, only its domain and position', () => {
    const note = competitorGroundingNote({
      competitor_evidence: { competitors: [{ domain: 'rival.com', position: 2, url: 'https://rival.com/secret-copy' }] },
    });
    assert.ok(!note.includes('secret-copy'));
  });

  test('the recommended action tells a human the same thing the backend will do', () => {
    const gap = {
      ...base, existing_page_match: 'https://ours.com/whitening',
      opportunity_type: 'improve_page', competitor_evidence: evidence, reason: 'rivals rank for this',
    };
    const action = recommendedActionForGap(gap);
    assert.equal(action.kind, 'improve-page');
    assert.equal(action.page, 'https://ours.com/whitening');
  });
});

describe('placement rules override competitor evidence', () => {
  const evidence = { competitors: [{ domain: 'rival.com', position: 3 }], ourPosition: 18 };
  const improveGap = (page, over = {}) => ({
    id: 9, topic: 'teeth whitening cost', product_relevance: 'direct', search_intent: 'commercial',
    existing_page_match: page, opportunity_type: 'improve_page', competitor_evidence: evidence, ...over,
  });

  test('a designed page is refused even with strong competitor evidence', () => {
    for (const page of ['https://ours.com/', 'https://ours.com/blog/', 'https://ours.com/products/', 'https://ours.com/customers/']) {
      assert.equal(gapDraftEligibility(improveGap(page)), null, page);
    }
  });

  test('a prose page is still allowed', () => {
    const e = gapDraftEligibility(improveGap('https://ours.com/blog/whitening-guide/'));
    assert.equal(e.generatorId, 'expand-content');
  });

  test('the refusal tells a human it was the wrong kind of page, not "nothing to add"', () => {
    const action = recommendedActionForGap(improveGap('https://ours.com/products/'));
    assert.equal(action.label, 'No action: wrong kind of page');
    assert.match(action.reason, /designed sections/);
  });

  test('an FAQ is not spliced into a designed page either', () => {
    const gap = improveGap('https://ours.com/', { topic: 'how much does teeth whitening cost' });
    assert.equal(gapDraftEligibility(gap), null);
  });

  test('the generator is told the fact rules along with the evidence', () => {
    const e = gapDraftEligibility(improveGap('https://ours.com/blog/whitening-guide/'));
    assert.match(e.shapeHint, /named source and a link/);
    assert.match(e.shapeHint, /rival\.com/);
  });

  test('blockedPlacementForGap stays silent when placement was not the problem', () => {
    assert.equal(blockedPlacementForGap({ id: 1, topic: 'x' }), null);
    assert.equal(blockedPlacementForGap(improveGap('https://ours.com/blog/post/')), null);
  });
});

describe('a comparison topic is never written into a page', () => {
  const comparisonGap = (page, over = {}) => ({
    id: 11, topic: 'zunkiree vs algolia', product_relevance: 'direct', search_intent: 'commercial',
    existing_page_match: page, opportunity_type: 'improve_page',
    competitor_evidence: { competitors: [{ domain: 'rival.com', position: 2 }] }, ...over,
  });

  test('a comparison topic with an existing page is refused, even with competitor evidence', () => {
    for (const page of ['https://ours.com/products/', 'https://ours.com/products/widget/', 'https://ours.com/about/']) {
      assert.equal(gapDraftEligibility(comparisonGap(page)), null, page);
    }
  });

  test('the human is told a comparison belongs elsewhere, not that there is nothing to add', () => {
    const action = recommendedActionForGap(comparisonGap('https://ours.com/products/'));
    assert.match(action.reason, /comparison must not be written into it/);
  });

  test('a comparison topic with no existing page still reports the missing infrastructure honestly', () => {
    const e = gapDraftEligibility({ id: 12, topic: 'zunkiree vs algolia', product_relevance: 'direct', search_intent: 'commercial' });
    assert.equal(e.requiresFutureInfrastructure, true);
  });
});
