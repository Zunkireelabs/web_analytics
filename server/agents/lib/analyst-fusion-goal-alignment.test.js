import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// 2026-09 Data Analyst audit finding #1: analyst-fusion.js's shipConclusion
// wrote to the SAME `recommendations` table every other agent's findings do
// but never carried goal_id/goal_alignment. This proves it now uses the
// identical goal-alignment evaluator every other recommendation-producing
// path already uses — never a second/different one.

const resolve = (p) => new URL(p, import.meta.url).href;

let inserted;
let existingRec;

mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    findOpenRecommendation: async () => existingRec,
    insertRecommendation: async (siteId, payload) => { inserted.push({ siteId, ...payload }); return { id: 999, ...payload }; },
    // Never called by shipConclusion itself — these exist only so
    // recommendation-coordinator.js's own top-level import (reached via
    // analyst-fusion.js's recommendationPageKey import) resolves.
    mergeIntoRecommendation: async () => { throw new Error('must not be reached'); },
    refreshRecommendationBlockState: async () => { throw new Error('must not be reached'); },
    listOpenRecommendations: async () => [],
    listOpenBlockedRecommendations: async () => [],
    closeStaleRecommendations: async () => 0,
    markRecommendationsUnfixable: async () => 0,
    getRecommendationById: async () => null,
    closeRecommendation: async () => {},
  },
});
// analyst-fusion.js imports these directly (recommendation-gates.js) or
// transitively (analyst-seo-mapping.js, via analyst-product-mapping.js) —
// neither is exercised by shipConclusion itself (its `gates` argument is
// injected directly below), but analyst-seo-mapping.js's own import graph
// reaches llm.js -> the openai SDK's formdata-node dependency, which fails
// under node:test's --experimental-test-module-mocks the same way documented
// elsewhere in this repo (see recommendations.js's default-bucket-decision.js
// comment for the identical issue). Stubbed here purely so the static import
// of analyst-fusion.js resolves without eagerly loading that chain.
mock.module(resolve('./recommendation-gates.js'), {
  namedExports: { createRecommendationGates: () => { throw new Error('must not be reached — shipConclusion takes gates by injection'); } },
});
mock.module(resolve('./analyst-seo-mapping.js'), {
  namedExports: {
    opportunityDraftEligibility: () => { throw new Error('must not be reached by shipConclusion'); },
    relatesToCapability: () => { throw new Error('must not be reached by shipConclusion'); },
  },
});
// analyst-fusion.js imports recommendationPageKey from recommendation-
// coordinator.js directly, which in turn imports command-center.js — whose
// own import of ../registry.js (every agent, several LLM-based) is the same
// heavy chain recommendations.goal-alignment.test.js already works around by
// mocking this exact module.
mock.module(resolve('./command-center.js'), {
  namedExports: { categoryByAgentId: async () => new Map() },
});

const { shipConclusion } = await import('./analyst-fusion.js');

function fakeGates(result = { drop: null, blockedReason: null }) {
  return { evaluate: async () => result };
}

function conclusion(overrides = {}) {
  return {
    generatorId: 'qa-content', params: { page: '/booking-software/pricing' }, page: '/booking-software/pricing',
    direction: 'decline-risk', corroboration: 3, confidence: 0.7, urgent: false,
    findingId: 'analyst-fusion:decline-risk:/booking-software/pricing',
    narrative: {
      observed: 'The page shows a real decline.', why: '3 independent evidence families corroborate the same conclusion.',
      cause: 'Maps to the pricing page.', action: 'qa-content on /booking-software/pricing',
      measurement: 'Re-measure in 31 days.',
    },
    ...overrides,
  };
}

beforeEach(() => { inserted = []; existingRec = null; });

describe('shipConclusion — goal alignment threading', () => {
  test('no active goals: goalId/goalAlignment are null, unchanged from before this feature existed', async () => {
    await shipConclusion(1, fakeGates(), conclusion(), []);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].goalId, null);
    assert.equal(inserted[0].goalAlignment, null);
  });

  test('an active goal whose target page matches attaches a strong alignment', async () => {
    const goals = [{ id: 7, objective: 'Generate leads for booking software', targetPagePatterns: ['/booking-software/*'], importance: 1, status: 'active' }];
    await shipConclusion(1, fakeGates(), conclusion(), goals);
    assert.equal(inserted[0].goalId, 7);
    assert.equal(inserted[0].goalAlignment.level, 'strong');
  });

  test('an existing open recommendation short-circuits before any goal evaluation — never re-inserts', async () => {
    existingRec = { id: 42 };
    const result = await shipConclusion(1, fakeGates(), conclusion(), [{ id: 7, targetPagePatterns: ['/booking-software/*'], importance: 1 }]);
    assert.equal(result.recommendationId, 42);
    assert.equal(result.created, false);
    assert.equal(inserted.length, 0);
  });

  test('a dropped gate result never inserts, regardless of goal alignment', async () => {
    const result = await shipConclusion(1, fakeGates({ drop: 'soft-404', blockedReason: null }), conclusion(), [{ id: 7, targetPagePatterns: ['/booking-software/*'], importance: 1 }]);
    assert.equal(result.recommendationId, null);
    assert.equal(result.dropped, true);
    assert.equal(inserted.length, 0);
  });

  test('omitted activeGoals argument defaults to empty — never throws', async () => {
    await assert.doesNotReject(() => shipConclusion(1, fakeGates(), conclusion()));
    assert.equal(inserted[0].goalId, null);
  });

  test('a goal with no page-pattern or topical match attaches "none", not a fabricated strong/partial level', async () => {
    const goals = [{ id: 3, objective: 'Reduce bounce on unrelated pages', targetPagePatterns: ['/support/*'], importance: 1, status: 'active' }];
    await shipConclusion(1, fakeGates(), conclusion(), goals);
    assert.equal(inserted[0].goalAlignment.level, 'none');
  });
});
