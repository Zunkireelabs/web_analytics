import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// The content-gap ship cycle (qualifyAndShipContentGaps) had NO daily cap of
// any kind until 2026-09-08: it looped over every qualifying gap and opened a
// draft for each. Its drafts carry source='analyst-keyword-gap', which
// auto-remediation.js's own budget (source='auto-remediation') and job.js's
// platform-wide ceiling both counted right past — so this lane could ship
// unbounded PRs that no limit in the system ever saw.
//
// This file covers ONLY the cap. Qualification gates and the weekly-cycle
// boundary have their own file (analyst-seo-mapping-content-gap-ship-cycle.
// test.js), which is dryRun-only by construction — its mocks throw on any
// write — so the wet-run path the cap actually governs needs its own mocks.
let pendingGaps;
let spentToday;
let statusUpdates;
let draftsGenerated;
let hasRecentDraft;
let faqWeeklyShipped;

const realDataAnalyst = await import(resolve('../../store/data-analyst.js'));
mock.module(resolve('../../store/data-analyst.js'), {
  namedExports: {
    ...realDataAnalyst,
    getKeywordGaps: async () => pendingGaps,
    updateKeywordGapStatus: async (siteId, gapId, status) => { statusUpdates.push({ gapId, status }); return null; },
    appendKeywordGapEvidenceSnapshot: async () => {},
    getRelatedQueriesForTopic: async () => [],
    getProductCapabilities: async () => [],
    getRecentCapabilityVisibilitySnapshots: async () => [],
    recordCapabilityVisibilitySnapshot: async () => {},
  },
});
// Mocked WITHOUT importing the real module first: store/drafts.js pulls in a
// dependency chain (formdata-node) that fails to load under this Node's ESM
// resolution, and spreading the real exports would drag it in for no benefit
// — only these two are reachable from the code under test.
mock.module(resolve('../../store/drafts.js'), {
  namedExports: {
    countDraftsBySourceToday: async () => spentToday,
    countDraftsBySourceAndTypeThisWeek: async () => faqWeeklyShipped,
    getLiveDraftsByFindingId: async () => new Map(),
    getDraftedFindingIds: async () => new Set(),
    getPendingDraftFilePaths: async () => new Set(),
    countFailedAttemptsByFinding: async () => new Map(),
    hasRecentDraftOfType: async () => hasRecentDraft,
  },
});
const realRead = await import(resolve('../../store/read.js'));
mock.module(resolve('../../store/read.js'), {
  namedExports: { ...realRead, getSiteById: async () => ({ id: 1, timezone: 'UTC' }) },
});
// Not spread from the real module, for the same formdata-node reason as
// store/drafts.js above — these three are all the code under test reaches.
mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    findOpenRecommendation: async () => null,
    insertRecommendation: async () => ({ id: 77 }),
    refreshRecommendationBlockState: async () => {},
  },
});
mock.module(resolve('./recommendation-coordinator.js'), {
  namedExports: { recommendationPageKey: (item) => item?.params?.page || '' },
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
  namedExports: {
    generateDraft: async (siteId, opts) => { draftsGenerated.push(opts); return { id: draftsGenerated.length, status: 'draft' }; },
  },
});
mock.module(resolve('./recommendation-gates.js'), {
  namedExports: { createRecommendationGates: () => ({ evaluate: async () => ({ blockedReason: null }) }) },
});

const { qualifyAndShipContentGaps } = await import('./analyst-seo-mapping.js');

const THIS_MONDAY = new Date('2026-08-31T00:00:00Z');
// Old enough to clear the 2-week gather window (qualifyAndShipContentGaps
// requires first_discovery_week to be at least 2 full weeks before `now`) —
// named LAST_WEEK for historical reasons but no longer literally last week.
const LAST_WEEK = '2026-08-17';

// faq: true routes gapDraftEligibility to the 'faq' generator (an
// existing-page match on a question-shaped topic) instead of 'blog-outline'.
// Most tests below now use faq gaps deliberately: blog-outline gained its
// own topic-pool (top 5 by search_volume) and one-per-run/3-day cadence gate
// (see the "blog topic pool + cadence" describe block below), so a fixture
// that resolves to blog-outline can no longer demonstrate the plain daily
// cap in isolation — it would always be bound to 1 ship first.
function gap(id, { faq = false } = {}) {
  return {
    id, topic: faq ? `how does topic ${id} work` : `topic ${id}`, reason: null, priority: 'medium', status: 'pending_review',
    search_intent: 'informational', product_relevance: 'direct', existing_page_match: faq ? '/blog/existing-page' : null,
    observation_count: 2,
    first_discovery_week: LAST_WEEK, last_observed_week: LAST_WEEK,
    evidence_snapshots: [
      { observed_at: '2026-08-17T00:00:00Z', impressions: 40, position: 6 },
      { observed_at: '2026-08-24T00:00:00Z', impressions: 55, position: 5 },
    ],
  };
}

const ship = () => qualifyAndShipContentGaps(1, { id: 1, timezone: 'UTC' }, { now: THIS_MONDAY });

beforeEach(() => {
  pendingGaps = []; spentToday = 0; statusUpdates = []; draftsGenerated = [];
  hasRecentDraft = false; faqWeeklyShipped = 0;
});

describe('qualifyAndShipContentGaps — daily cap', () => {
  test('ships every qualifying gap when well under the cap', async () => {
    pendingGaps = [gap(1, { faq: true }), gap(2, { faq: true }), gap(3, { faq: true })];
    const result = await ship();
    assert.equal(result.shipped, 3);
    assert.equal(result.deferred, 0);
    assert.equal(draftsGenerated.length, 3);
  });

  // spentToday is set well above (20 - FAQ_WEEKLY_MAX) so the DAILY remaining
  // (5) binds before the on-page weekly cap (10, unused this run) would —
  // otherwise, since FAQ_WEEKLY_MAX (10) is now tighter than
  // CONTENT_GAP_DAILY_MAX (20), a fresh run could never demonstrate the daily
  // cap specifically; the weekly cap would always bind first.
  test('stops at the daily cap and defers the rest instead of shipping unbounded', async () => {
    spentToday = 15;
    pendingGaps = Array.from({ length: 10 }, (_, i) => gap(i + 1, { faq: true }));
    const result = await ship();
    assert.equal(result.shipped, 5, '20/day cap minus 15 already spent leaves 5');
    assert.equal(result.deferred, 5);
    assert.equal(draftsGenerated.length, 5, 'no draft may be generated past the cap');
  });

  test('a deferred gap is NOT marked approved — it stays pending_review so the next run reconsiders it', async () => {
    spentToday = 10;
    pendingGaps = Array.from({ length: 12 }, (_, i) => gap(i + 1, { faq: true }));
    await ship();
    assert.equal(statusUpdates.length, 10, 'only shipped gaps get their status advanced');
    assert.ok(statusUpdates.every((u) => u.status === 'approved'));
  });

  test('drafts this lane already opened earlier today count against the same cap', async () => {
    spentToday = 18;
    pendingGaps = Array.from({ length: 10 }, (_, i) => gap(i + 1, { faq: true }));
    const result = await ship();
    assert.equal(result.shipped, 2, '20 cap minus 18 already spent leaves 2');
    assert.equal(result.deferred, 8);
  });

  test('a lane that already hit its cap today ships nothing at all on a later run', async () => {
    spentToday = 20;
    pendingGaps = [gap(1, { faq: true }), gap(2, { faq: true })];
    const result = await ship();
    assert.equal(result.shipped, 0);
    assert.equal(draftsGenerated.length, 0);
    assert.equal(result.deferred, 2);
  });

  test('the cap is reported back so a caller can see the budget, not just the outcome', async () => {
    spentToday = 3;
    pendingGaps = [gap(1, { faq: true })];
    const result = await ship();
    assert.equal(result.dailyLimit, 20);
    assert.equal(result.spentToday, 3);
  });

  test('a dryRun never consults or consumes the budget', async () => {
    pendingGaps = Array.from({ length: 25 }, (_, i) => gap(i + 1));
    const result = await qualifyAndShipContentGaps(1, { id: 1, timezone: 'UTC' }, { dryRun: true, now: THIS_MONDAY });
    assert.equal(result.spentToday, 0);
    assert.equal(draftsGenerated.length, 0);
    assert.equal(statusUpdates.length, 0);
  });
});

// New with the blog/on-page cadence split: net-new blog topics are ranked by
// real search_volume and thinned to a pool of 5 before the one-per-run/3-day
// cadence gate even runs; on-page (faq) updates get their own weekly cap
// independent of blog's. Covered separately from the daily-cap suite above
// since these gates bind BEFORE the daily budget ever gets consulted.
describe('qualifyAndShipContentGaps — blog topic pool + cadence, on-page weekly cap', () => {
  test('only the top 5 blog-outline gaps by search_volume enter the pool; a lower-volume one is deferred even with room in the daily budget', async () => {
    pendingGaps = [
      { ...gap(1), search_volume: 100 },
      { ...gap(2), search_volume: 900 },
      { ...gap(3), search_volume: 500 },
      { ...gap(4), search_volume: 10 },
      { ...gap(5), search_volume: 700 },
      { ...gap(6), search_volume: 50 },
    ];
    // Sorted desc by volume: 900(2), 700(5), 500(3), 100(1), 50(6), 10(4) —
    // gap 4 (volume 10) is 6th and never enters the pool of 5.
    const result = await ship();
    const sixth = result.results.find((r) => r.gapId === 4);
    assert.equal(sixth.qualified, false);
    assert.match(sixth.reason, /blog-topic-pool-cap/);
  });

  test('an LLM-guessed gap with no real search_volume sorts to the back of the pool, never excluded outright', async () => {
    pendingGaps = [
      { ...gap(1), search_volume: null }, // claude_research — no real number
      { ...gap(2), search_volume: 5 },
    ];
    const result = await ship();
    // Only one blog-outline ships per run regardless (see below); the real,
    // if tiny, measured volume outranks the unmeasured guess.
    assert.equal(result.results.find((r) => r.gapId === 2).qualified, true);
    assert.equal(result.results.find((r) => r.gapId === 1).qualified, false);
  });

  test('at most one blog-outline draft ships per run even with several in the pool', async () => {
    pendingGaps = [{ ...gap(1), search_volume: 300 }, { ...gap(2), search_volume: 200 }];
    const result = await ship();
    assert.equal(result.shipped, 1);
    assert.equal(result.results.find((r) => r.gapId === 2).reason, 'blog-one-per-run');
  });

  test('no blog-outline ships at all if one already shipped within the cadence gap', async () => {
    hasRecentDraft = true;
    pendingGaps = [{ ...gap(1), search_volume: 300 }];
    const result = await ship();
    assert.equal(result.shipped, 0);
    assert.match(result.results[0].reason, /blog-cadence-gap/);
  });

  test('on-page (faq) updates are capped to FAQ_WEEKLY_MAX regardless of the daily budget', async () => {
    faqWeeklyShipped = 8; // 2 remaining this week
    pendingGaps = Array.from({ length: 5 }, (_, i) => gap(i + 1, { faq: true }));
    const result = await ship();
    assert.equal(result.shipped, 2, '10/week cap minus 8 already shipped this week leaves 2');
    assert.equal(result.deferred, 3);
    assert.match(result.results.find((r) => !r.qualified).reason, /on-page-weekly-cap/);
  });
});
