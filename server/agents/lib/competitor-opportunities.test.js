import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpportunities, scoreOpportunity, OPPORTUNITY_TYPES } from './competitor-opportunities.js';

// The invariants worth protecting, in order of how much damage breaking them would do:
//   1. never propose a new page for something an existing page already targets or ranks for
//   2. never let raw search volume decide the order
//   3. never propose something already in the queue
//   4. never invent a metric the provider did not return

const fp = (keyword, over = {}) => ({
  competitor_domain: over.domain || 'rival.com',
  keyword,
  location_code: 2524,
  language_code: 'en',
  position: 'position' in over ? over.position : 4,
  ranking_url: over.url || `https://rival.com/${keyword.replace(/\s+/g, '-')}`,
  search_volume: 'volume' in over ? over.volume : 300,
  keyword_difficulty: 'kd' in over ? over.kd : 35,
  search_intent: 'intent' in over ? over.intent : 'commercial',
  captured_at: new Date('2026-11-01T00:00:00Z'),
});
const services = ['teeth whitening', 'dental implants'];

describe('improve vs create — the decision that matters most', () => {
  test('a keyword an existing page already targets becomes improve_page, never a new page', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [fp('teeth whitening cost')],
      ourPages: [{ url: 'https://ours.com/whitening', keywords: ['teeth whitening cost'] }],
      serviceTerms: services,
    });
    assert.equal(opportunities[0].opportunityType, OPPORTUNITY_TYPES.IMPROVE_PAGE);
    assert.equal(opportunities[0].existingPageMatch, 'https://ours.com/whitening');
    assert.equal(opportunities[0].contentPlan, 'track');
  });

  test('a page whose title and URL cover every keyword word counts as a match', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [fp('dental implants price')],
      ourPages: [{ url: 'https://ours.com/dental-implants-price', title: 'Dental Implants Price' }],
      serviceTerms: services,
    });
    assert.equal(opportunities[0].opportunityType, OPPORTUNITY_TYPES.IMPROVE_PAGE);
    assert.equal(opportunities[0].evidence.matchedBy, 'page_title_or_url');
  });

  test('a page we already rank with is improved, even with no declared keywords', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [fp('teeth whitening cost')],
      ourQueries: [{ query: 'teeth whitening cost', avg_position: 18, page: 'https://ours.com/services' }],
      serviceTerms: services,
    });
    assert.equal(opportunities[0].opportunityType, OPPORTUNITY_TYPES.IMPROVE_PAGE);
    assert.equal(opportunities[0].evidence.matchedBy, 'already_ranking_page');
  });

  test('ranking far behind the best rival is a position gap, not a new page', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [fp('teeth whitening cost', { position: 2 })],
      ourQueries: [{ query: 'teeth whitening cost', avg_position: 25 }],
      serviceTerms: services,
    });
    assert.equal(opportunities[0].opportunityType, OPPORTUNITY_TYPES.POSITION_GAP);
    assert.equal(opportunities[0].ourPosition, 25);
    assert.equal(opportunities[0].bestCompetitorPosition, 2);
  });

  test('ranking just behind is an improvement, not a gap', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [fp('teeth whitening cost', { position: 5 })],
      ourQueries: [{ query: 'teeth whitening cost', avg_position: 9 }],
      serviceTerms: services,
    });
    assert.equal(opportunities[0].opportunityType, OPPORTUNITY_TYPES.IMPROVE_PAGE);
  });

  test('a keyword we already rank top-3 for produces nothing at all', () => {
    const { opportunities, rejected } = buildOpportunities({
      footprintRows: [fp('teeth whitening')],
      ourQueries: [{ query: 'teeth whitening', avg_position: 2 }],
      serviceTerms: services,
    });
    assert.equal(opportunities.length, 0);
    assert.equal(rejected[0].reason, 'already_covered_and_competitive');
  });

  test('a service-and-place phrase we have nothing for is a landing page', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [fp('teeth whitening pokhara')],
      serviceTerms: services,
      locationNames: ['Pokhara', 'Nepal'],
    });
    assert.equal(opportunities[0].opportunityType, OPPORTUNITY_TYPES.SERVICE_LOCATION);
    assert.equal(opportunities[0].contentPlan, 'landing');
  });

  test('a modifier is not a place: "cost" and "near me" are ordinary missing keywords', () => {
    for (const keyword of ['teeth whitening cost', 'teeth whitening near me']) {
      const { opportunities } = buildOpportunities({
        footprintRows: [fp(keyword)], serviceTerms: services, locationNames: ['Pokhara', 'Nepal'],
      });
      assert.equal(opportunities[0].opportunityType, OPPORTUNITY_TYPES.MISSING, keyword);
    }
  });

  test('with no known markets, nothing is claimed to be location work', () => {
    const { opportunities } = buildOpportunities({ footprintRows: [fp('teeth whitening pokhara')], serviceTerms: services });
    assert.equal(opportunities[0].opportunityType, OPPORTUNITY_TYPES.MISSING);
  });
});

describe('filtering out what is not evidence', () => {
  test('a rival outside the top ten is not evidence', () => {
    const { opportunities, rejected } = buildOpportunities({ footprintRows: [fp('whitening deep', { position: 28 })], serviceTerms: services });
    assert.equal(opportunities.length, 0);
    assert.equal(rejected[0].reason, 'no_competitor_in_top_10');
  });

  test('a keyword with no position at all is not evidence', () => {
    const { opportunities } = buildOpportunities({ footprintRows: [fp('whitening unknown', { position: null })], serviceTerms: services });
    assert.equal(opportunities.length, 0);
  });

  test('a topic already in the queue is never proposed again, whatever its status', () => {
    const { opportunities, rejected } = buildOpportunities({
      footprintRows: [fp('teeth whitening cost')],
      existingGaps: [{ topic: 'Teeth Whitening Cost', status: 'dismissed' }],
      serviceTerms: services,
    });
    assert.equal(opportunities.length, 0);
    assert.equal(rejected[0].reason, 'already_in_queue');
  });

  test('the same keyword from several rivals is one opportunity with all of them as evidence', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [
        fp('teeth whitening cost', { domain: 'a.com', position: 3 }),
        fp('teeth whitening cost', { domain: 'b.com', position: 6 }),
        fp('teeth whitening cost', { domain: 'c.com', position: 9 }),
      ],
      serviceTerms: services,
    });
    assert.equal(opportunities.length, 1);
    assert.equal(opportunities[0].evidence.competitorCount, 3);
    assert.equal(opportunities[0].bestCompetitorPosition, 3);
    assert.deepEqual(opportunities[0].evidence.competitors.map((c) => c.domain), ['a.com', 'b.com', 'c.com']);
  });
});

describe('metrics are measurements, not guesses', () => {
  test('an unreported metric stays null and lowers confidence', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [fp('whitening bare', { volume: null, kd: null, intent: null })],
      serviceTerms: services,
    });
    assert.equal(opportunities[0].searchVolume, null);
    assert.equal(opportunities[0].keywordDifficulty, null);
    assert.equal(opportunities[0].confidence, 'low');
  });

  test('all three metrics measured gives high confidence', () => {
    const { opportunities } = buildOpportunities({ footprintRows: [fp('whitening full')], serviceTerms: services });
    assert.equal(opportunities[0].confidence, 'high');
  });

  test('the strongest reported demand wins and difficulty is averaged', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [
        fp('whitening x', { domain: 'a.com', volume: 100, kd: 20 }),
        fp('whitening x', { domain: 'b.com', volume: 900, kd: 40 }),
      ],
      serviceTerms: services,
    });
    assert.equal(opportunities[0].searchVolume, 900);
    assert.equal(opportunities[0].keywordDifficulty, 30);
  });

  test('every opportunity carries evidence that explains it without re-querying the provider', () => {
    const { opportunities } = buildOpportunities({ footprintRows: [fp('whitening evidence')], serviceTerms: services });
    const o = opportunities[0];
    assert.equal(o.evidence.competitors[0].domain, 'rival.com');
    assert.ok(o.evidence.competitors[0].capturedAt);
    assert.match(o.reason, /position 4/);
  });
});

describe('prioritisation is not search volume', () => {
  test('a huge unwinnable informational keyword loses to a modest winnable commercial one', () => {
    const huge = scoreOpportunity({ type: OPPORTUNITY_TYPES.MISSING, demand: 200000, difficulty: 95, intent: 'informational', competitorCount: 1 });
    const modest = scoreOpportunity({ type: OPPORTUNITY_TYPES.IMPROVE_PAGE, demand: 200, difficulty: 15, intent: 'transactional', competitorCount: 3 });
    assert.ok(modest.score > huge.score, `modest ${modest.score} should beat huge ${huge.score}`);
  });

  test('work on an existing page outranks an identical new page', () => {
    const common = { demand: 500, difficulty: 30, intent: 'commercial', competitorCount: 2 };
    assert.ok(
      scoreOpportunity({ ...common, type: OPPORTUNITY_TYPES.IMPROVE_PAGE }).score
      > scoreOpportunity({ ...common, type: OPPORTUNITY_TYPES.MISSING }).score
    );
  });

  test('our own authority changes what counts as winnable', () => {
    const hard = { type: OPPORTUNITY_TYPES.MISSING, demand: 500, difficulty: 70, intent: 'commercial', competitorCount: 2 };
    assert.ok(scoreOpportunity({ ...hard, authorityScore: 80 }).score > scoreOpportunity({ ...hard, authorityScore: 10 }).score);
  });

  test('more rivals on one keyword is stronger evidence', () => {
    const base = { type: OPPORTUNITY_TYPES.MISSING, demand: 500, difficulty: 30, intent: 'commercial' };
    assert.ok(scoreOpportunity({ ...base, competitorCount: 3 }).score > scoreOpportunity({ ...base, competitorCount: 1 }).score);
  });

  test('verified learning nudges the order but cannot override the evidence', () => {
    const base = { type: OPPORTUNITY_TYPES.MISSING, demand: 500, difficulty: 30, intent: 'commercial', competitorCount: 2 };
    const neutral = scoreOpportunity(base).score;
    assert.ok(scoreOpportunity({ ...base, learnedMultiplier: 5 }).score <= Math.min(1, neutral * 1.3) + 1e-9);
    assert.ok(scoreOpportunity({ ...base, learnedMultiplier: 0 }).score >= neutral * 0.7 - 1e-9);
  });

  test('every score stays within 0..1 and opportunities come back best first', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [fp('whitening low', { volume: 10, kd: 90 }), fp('whitening high', { volume: 5000, kd: 10, intent: 'transactional' })],
      serviceTerms: services,
    });
    for (const o of opportunities) assert.ok(o.score >= 0 && o.score <= 1, `score ${o.score}`);
    assert.deepEqual(opportunities.map((o) => o.keyword), ['whitening high', 'whitening low']);
  });

  test('the score is explained by its parts, so an order can always be justified', () => {
    const { opportunities } = buildOpportunities({ footprintRows: [fp('whitening parts')], serviceTerms: services });
    assert.deepEqual(Object.keys(opportunities[0].scoreParts).sort(), ['capabilityPart', 'demandPart', 'evidencePart', 'intentPart', 'learned', 'winnability']);
  });
});

describe('topic clusters', () => {
  test('several rivals strong across one uncovered service become a pillar plus supporting work', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [
        fp('teeth whitening cost', { domain: 'a.com' }), fp('teeth whitening cost', { domain: 'b.com' }), fp('teeth whitening cost', { domain: 'c.com' }),
        fp('teeth whitening aftercare', { domain: 'a.com' }), fp('teeth whitening aftercare', { domain: 'b.com' }), fp('teeth whitening aftercare', { domain: 'c.com' }),
      ],
      serviceTerms: services,
    });
    const roles = opportunities.filter((o) => o.topicGap).map((o) => o.clusterRole);
    assert.equal(roles.filter((r) => r === 'pillar').length, 1);
    assert.ok(roles.includes('supporting'));
    assert.equal(opportunities[0].topicCluster, 'teeth whitening');
  });

  test('one rival on one keyword is not a topic gap', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [fp('teeth whitening cost'), fp('teeth whitening aftercare')],
      serviceTerms: services,
    });
    assert.equal(opportunities.filter((o) => o.topicGap).length, 0);
  });

  test('a keyword outside the client\'s vocabulary gets no cluster', () => {
    const { opportunities } = buildOpportunities({ footprintRows: [fp('unrelated mortgage advice')], serviceTerms: services });
    assert.equal(opportunities[0].topicCluster, undefined);
  });
});

describe('empty and degenerate input', () => {
  test('no footprint means no opportunities and no crash', () => {
    assert.deepEqual(buildOpportunities({}).opportunities, []);
    assert.deepEqual(buildOpportunities({ footprintRows: [] }).opportunities, []);
  });

  test('rows without a keyword are ignored', () => {
    const { opportunities } = buildOpportunities({ footprintRows: [fp(''), { competitor_domain: 'a.com', position: 3 }], serviceTerms: services });
    assert.deepEqual(opportunities, []);
  });

  test('a GSC position arriving as a string is still understood', () => {
    const { opportunities } = buildOpportunities({
      footprintRows: [fp('teeth whitening cost', { position: 2 })],
      ourQueries: [{ dim_value: 'teeth whitening cost', avg_position: '25.4' }],
      serviceTerms: services,
    });
    assert.equal(opportunities[0].opportunityType, OPPORTUNITY_TYPES.POSITION_GAP);
    assert.equal(opportunities[0].ourPosition, 25.4);
  });
});
