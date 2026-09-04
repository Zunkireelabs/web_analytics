import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// qualifyAndShipContentGaps (analyst-seo-mapping.js) is the biweekly
// autonomous half of content-gap shipping: it must NEVER qualify a gap that
// hasn't survived at least one re-observation (observation_count >= 2), that
// isn't relevant to a real product ('unrelated' never qualifies), or whose
// real GSC demand dropped between its two most recent weekly snapshots. All
// three gates are exercised here via dryRun:true, which never calls
// createActionCenterRecommendationForGap (and therefore needs none of its
// heavy dependency chain — generateDraft, recommendation-gates, etc.).

let pendingGaps;

const realDataAnalyst = await import(resolve('../../store/data-analyst.js'));
mock.module(resolve('../../store/data-analyst.js'), {
  namedExports: {
    ...realDataAnalyst,
    getKeywordGaps: async () => pendingGaps,
    appendKeywordGapEvidenceSnapshot: async () => {},
    updateKeywordGapStatus: async () => { throw new Error('dryRun must never write status'); },
    setGapClassification: async () => { throw new Error('not exercised by this test file'); },
    getRelatedQueriesForTopic: async () => [],
    getProductCapabilities: async () => [],
    getRecentCapabilityVisibilitySnapshots: async () => [],
    recordCapabilityVisibilitySnapshot: async () => {},
  },
});
const realRead = await import(resolve('../../store/read.js'));
mock.module(resolve('../../store/read.js'), {
  namedExports: { ...realRead, getSiteById: async () => ({ id: 1 }) },
});
mock.module(resolve('../../store/page-inventory.js'), {
  namedExports: { listPageInventory: async () => [] },
});
mock.module(resolve('./page-content.js'), {
  namedExports: {
    analyzePageUrl: async () => ({ ok: false }),
    hasSufficientGroundingContent: () => false,
    isPrivateOrLocalHost: () => false,
    fetchResponseHeaders: async () => ({}),
    isCompressedEncoding: () => false,
  },
});
mock.module(resolve('../../llm.js'), {
  namedExports: { callLLMForJson: async () => { throw new Error('not exercised by this test file'); } },
});
mock.module(resolve('../../routes/action-center.js'), {
  namedExports: { generateDraft: async () => { throw new Error('dryRun must never generate a draft'); } },
});
mock.module(resolve('./recommendation-coordinator.js'), {
  namedExports: { recommendationPageKey: () => { throw new Error('dryRun must never write a recommendation'); } },
});

const { qualifyAndShipContentGaps, hasStableOrGrowingDemand } = await import('./analyst-seo-mapping.js');

function baseGap(overrides = {}) {
  return {
    id: 1, topic: 'ai booking engine nepal', reason: null, priority: 'medium', status: 'pending_review',
    search_intent: 'commercial', product_relevance: 'direct', existing_page_match: null,
    observation_count: 2,
    evidence_snapshots: [
      { observed_at: '2026-08-17T00:00:00Z', impressions: 40, position: 6 },
      { observed_at: '2026-08-24T00:00:00Z', impressions: 55, position: 5 },
    ],
    ...overrides,
  };
}

beforeEach(() => { pendingGaps = []; });

describe('hasStableOrGrowingDemand', () => {
  test('fewer than 2 snapshots — never qualifies (nothing to compare)', () => {
    assert.equal(hasStableOrGrowingDemand({ evidence_snapshots: [{ impressions: 40 }] }), false);
    assert.equal(hasStableOrGrowingDemand({ evidence_snapshots: [] }), false);
  });

  test('growing impressions between the two most recent snapshots qualifies', () => {
    assert.equal(hasStableOrGrowingDemand({ evidence_snapshots: [{ impressions: 40 }, { impressions: 55 }] }), true);
  });

  test('stable (equal) impressions qualifies', () => {
    assert.equal(hasStableOrGrowingDemand({ evidence_snapshots: [{ impressions: 40 }, { impressions: 40 }] }), true);
  });

  test('declining impressions does NOT qualify', () => {
    assert.equal(hasStableOrGrowingDemand({ evidence_snapshots: [{ impressions: 60 }, { impressions: 10 }] }), false);
  });

  test('a true zero-impressions white-space topic (never had GSC signal) still qualifies on recurrence/relevance alone', () => {
    assert.equal(hasStableOrGrowingDemand({ evidence_snapshots: [{ impressions: 0 }, { impressions: 0 }] }), true);
  });

  test('only the two MOST RECENT snapshots matter — an older decline before a recent rise still qualifies', () => {
    assert.equal(hasStableOrGrowingDemand({
      evidence_snapshots: [{ impressions: 100 }, { impressions: 10 }, { impressions: 30 }],
    }), true);
  });
});

describe('qualifyAndShipContentGaps — qualification gates (dryRun, no writes)', () => {
  test('a freshly-discovered gap (observation_count 1) never qualifies, regardless of everything else looking perfect', async () => {
    pendingGaps = [baseGap({ observation_count: 1 })];
    const result = await qualifyAndShipContentGaps(1, { id: 1 }, { dryRun: true });
    assert.equal(result.candidates, 0);
    assert.equal(result.shipped, 0);
  });

  test('an "unrelated" product_relevance gap never auto-qualifies, even with 2+ growing observations', async () => {
    pendingGaps = [baseGap({ product_relevance: 'unrelated' })];
    const result = await qualifyAndShipContentGaps(1, { id: 1 }, { dryRun: true });
    assert.equal(result.candidates, 0);
  });

  test('"supporting" product_relevance (not just "direct") is allowed to qualify', async () => {
    pendingGaps = [baseGap({ product_relevance: 'supporting' })];
    const result = await qualifyAndShipContentGaps(1, { id: 1 }, { dryRun: true });
    assert.equal(result.candidates, 1);
  });

  test('a one-off spike followed by a drop does not qualify', async () => {
    pendingGaps = [baseGap({
      evidence_snapshots: [{ impressions: 90, position: 4 }, { impressions: 8, position: 9 }],
    })];
    const result = await qualifyAndShipContentGaps(1, { id: 1 }, { dryRun: true });
    assert.equal(result.candidates, 0);
  });

  test('a fully-qualifying, blog-shaped gap is selected and its generator is reported, without shipping (dryRun)', async () => {
    // informational intent (not commercial/transactional) routes to
    // blog-outline, not landing-page — see gapDraftEligibility. This is the
    // shape the biweekly cron is allowed to auto-approve.
    pendingGaps = [baseGap({ search_intent: 'informational' })];
    const result = await qualifyAndShipContentGaps(1, { id: 1 }, { dryRun: true });
    assert.equal(result.candidates, 1);
    assert.equal(result.shipped, 0, 'dryRun must never actually ship');
    assert.equal(result.results[0].generatorId, 'blog-outline');
    assert.equal(result.results[0].dryRun, true);
  });

  test('a landing-page-shaped gap is NEVER auto-approved, even when every other gate passes — it needs a human "yes" on the Analyst page first', async () => {
    // baseGap() defaults to commercial + direct relevance, i.e. exactly the
    // combination gapDraftEligibility routes to 'landing-page'.
    pendingGaps = [baseGap()];
    const result = await qualifyAndShipContentGaps(1, { id: 1 }, { dryRun: true });
    assert.equal(result.candidates, 1, 'it still counts as a real candidate — the evidence is genuine');
    assert.equal(result.shipped, 0);
    assert.equal(result.results[0].qualified, false);
    assert.equal(result.results[0].reason, 'landing-page-needs-human-approval');
    assert.equal(result.results[0].generatorId, 'landing-page');
  });

  test('mixed pending queue: only the qualifying gap is selected, others are excluded with no side effects', async () => {
    pendingGaps = [
      baseGap({ id: 1, observation_count: 1 }), // too new
      baseGap({ id: 2, product_relevance: 'unrelated' }), // not relevant
      baseGap({ id: 3, evidence_snapshots: [{ impressions: 50 }, { impressions: 5 }] }), // declining
      baseGap({ id: 4, search_intent: 'informational' }), // qualifies and auto-ships (blog-shaped)
    ];
    const result = await qualifyAndShipContentGaps(1, { id: 1 }, { dryRun: true });
    assert.equal(result.pending, 4);
    assert.equal(result.candidates, 1);
    assert.equal(result.results[0].gapId, 4);
    assert.equal(result.results[0].qualified, true);
  });
});
