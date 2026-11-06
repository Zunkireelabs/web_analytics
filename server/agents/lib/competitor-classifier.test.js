import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCompetitor, classifyAll, isAggregatorDomain, looksLikeAggregatorText, KINDS } from './competitor-classifier.js';

// The invariant worth protecting: a directory, a platform or a one-keyword domain must never be labelled 'business',
// because only 'business' rows drive paid research and content work.

const clinicHomepage = 'We are a dental clinic in Pokhara offering teeth whitening, dental implants and emergency dental care.';

describe('classifyCompetitor', () => {
  test('a social/search platform is excluded, not classified', () => {
    const out = classifyCompetitor('facebook.com', { serpQueryHits: 9, queriesChecked: 10 });
    assert.equal(out.kind, null);
    assert.equal(out.excludedReason, 'platform');
  });

  test('a subdomain of a platform is also excluded', () => {
    assert.equal(classifyCompetitor('np.linkedin.com', { serpQueryHits: 5, queriesChecked: 5 }).excludedReason, 'platform');
  });

  test('a known directory is organic even when it dominates the SERPs', () => {
    const out = classifyCompetitor('yelp.com', { serpQueryHits: 10, queriesChecked: 10, serviceTermOverlap: 0.9, locationMatch: true });
    assert.equal(out.kind, KINDS.ORGANIC);
    assert.equal(out.relevanceScore, 0);
    assert.equal(out.confidence, 'high');
  });

  test('an unlisted site that calls itself a directory is organic', () => {
    const out = classifyCompetitor('pokhara-listings.com', {
      serpQueryHits: 6, queriesChecked: 10, serviceTermOverlap: 0.5, locationMatch: true,
      homepageText: 'The best directory of dental clinics. Browse reviews of local dentists and compare quotes.',
    });
    assert.equal(out.kind, KINDS.ORGANIC);
    assert.equal(out.evidence.aggregatorSelfDescribed, true);
  });

  test('one mention of a directory-ish word is not enough', () => {
    const out = classifyCompetitor('realclinic.com', {
      serpQueryHits: 4, queriesChecked: 10, serviceTermOverlap: 0.5, locationMatch: true,
      homepageText: `${clinicHomepage} Browse our services.`,
    });
    assert.equal(out.kind, KINDS.BUSINESS);
  });

  test('a domain seen for one query only is keyword_specific', () => {
    const out = classifyCompetitor('onehit.com', { serpQueryHits: 1, queriesChecked: 10, serviceTermOverlap: 0.8, locationMatch: true });
    assert.equal(out.kind, KINDS.KEYWORD_SPECIFIC);
  });

  test('same offering, same market, several searches = business', () => {
    const out = classifyCompetitor('rivalclinic.com', {
      serpQueryHits: 7, queriesChecked: 10, serviceTermOverlap: 0.6, locationMatch: true, homepageText: clinicHomepage,
    });
    assert.equal(out.kind, KINDS.BUSINESS);
    assert.equal(out.confidence, 'high');
    assert.ok(out.relevanceScore > 0.5);
  });

  test('low service overlap stays organic however often it ranks', () => {
    const out = classifyCompetitor('newspaper.com', { serpQueryHits: 9, queriesChecked: 10, serviceTermOverlap: 0.05, locationMatch: true });
    assert.equal(out.kind, KINDS.ORGANIC);
  });

  test('a different market is never business', () => {
    const out = classifyCompetitor('ukclinic.co.uk', { serpQueryHits: 5, queriesChecked: 10, serviceTermOverlap: 0.9, locationMatch: false });
    assert.equal(out.kind, KINDS.ORGANIC);
  });

  test('an unreadable homepage cannot become business, and says so in its confidence', () => {
    const out = classifyCompetitor('unknown.com', { serpQueryHits: 6, queriesChecked: 10, serviceTermOverlap: null, locationMatch: true });
    assert.equal(out.kind, KINDS.ORGANIC);
    assert.equal(out.confidence, 'low');
  });

  test('no SERP evidence at all gives low confidence, not a confident verdict', () => {
    const out = classifyCompetitor('unverified.com', { serpQueryHits: 0, queriesChecked: 0, serviceTermOverlap: null });
    assert.equal(out.confidence, 'low');
    assert.equal(out.relevanceScore, 0);
  });

  test('unmeasured signals are recorded as null, never as zero', () => {
    const { evidence } = classifyCompetitor('x.example', { serpQueryHits: 3, queriesChecked: 5 });
    assert.equal(evidence.serviceTermOverlap, null);
    assert.equal(evidence.locationMatch, null);
    assert.equal(evidence.aggregatorSelfDescribed, null);
  });

  test('every classification carries its evidence and a human-readable reason', () => {
    const out = classifyCompetitor('rivalclinic.com', { serpQueryHits: 7, queriesChecked: 10, serviceTermOverlap: 0.6, locationMatch: true });
    assert.equal(out.evidence.domain, 'rivalclinic.com');
    assert.match(out.reason, /7 of 10/);
    assert.ok(out.evidence.decidedAt);
  });

  test('a junk domain is excluded rather than scored', () => {
    const out = classifyCompetitor('not a domain', { serpQueryHits: 5, queriesChecked: 5 });
    assert.equal(out.kind, null);
    assert.equal(out.excludedReason, 'invalid_domain');
  });

  test('relevance score stays within 0..1', () => {
    const out = classifyCompetitor('rival.com', { serpQueryHits: 99, queriesChecked: 10, serviceTermOverlap: 5, locationMatch: true });
    assert.ok(out.relevanceScore >= 0 && out.relevanceScore <= 1, `got ${out.relevanceScore}`);
  });
});

describe('helpers', () => {
  test('aggregator matching covers subdomains', () => {
    assert.equal(isAggregatorDomain('www.yelp.com'), true);
    assert.equal(isAggregatorDomain('in.tripadvisor.com'), true);
    assert.equal(isAggregatorDomain('myclinic.com'), false);
  });

  test('no homepage text means not measured, not "no"', () => {
    assert.equal(looksLikeAggregatorText(null), null);
    assert.equal(looksLikeAggregatorText('')?.matched ?? null, null);
  });
});

describe('classifyAll', () => {
  const candidates = [
    { domain: 'rival1.com', serpQueryHits: 8, queriesChecked: 10, serviceTermOverlap: 0.7, locationMatch: true },
    { domain: 'rival2.com', serpQueryHits: 6, queriesChecked: 10, serviceTermOverlap: 0.5, locationMatch: true },
    { domain: 'rival3.com', serpQueryHits: 4, queriesChecked: 10, serviceTermOverlap: 0.4, locationMatch: true },
    { domain: 'yelp.com', serpQueryHits: 10, queriesChecked: 10, serviceTermOverlap: 0.9, locationMatch: true },
    { domain: 'facebook.com', serpQueryHits: 10, queriesChecked: 10 },
    { domain: 'onehit.com', serpQueryHits: 1, queriesChecked: 10, serviceTermOverlap: 0.9, locationMatch: true },
  ];

  test('splits the groups and never puts a platform or directory in business', () => {
    const out = classifyAll(candidates);
    assert.deepEqual(out.business.map((c) => c.domain), ['rival1.com', 'rival2.com', 'rival3.com']);
    assert.deepEqual(out.organic.map((c) => c.domain), ['yelp.com']);
    assert.deepEqual(out.keywordSpecific.map((c) => c.domain), ['onehit.com']);
    assert.deepEqual(out.excluded.map((c) => c.domain), ['facebook.com']);
  });

  test('business is ordered by evidence and capped, with the rest kept visible', () => {
    const out = classifyAll(candidates, { maxBusiness: 2 });
    assert.deepEqual(out.business.map((c) => c.domain), ['rival1.com', 'rival2.com']);
    assert.deepEqual(out.overflowBusiness.map((c) => c.domain), ['rival3.com']);
  });

  test('the cap does not drop organic or keyword evidence', () => {
    const out = classifyAll(candidates, { maxBusiness: 1 });
    assert.equal(out.organic.length, 1);
    assert.equal(out.keywordSpecific.length, 1);
  });
});
