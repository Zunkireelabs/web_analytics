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
    getLiveDraftsByFindingId: async () => new Map(),
    getDraftedFindingIds: async () => new Set(),
    getPendingDraftFilePaths: async () => new Set(),
    countFailedAttemptsByFinding: async () => new Map(),
    hasRecentDraftOfType: async () => false,
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
const LAST_WEEK = '2026-08-24';

function gap(id) {
  return {
    id, topic: `topic ${id}`, reason: null, priority: 'medium', status: 'pending_review',
    search_intent: 'informational', product_relevance: 'direct', existing_page_match: null,
    observation_count: 2,
    first_discovery_week: LAST_WEEK, last_observed_week: LAST_WEEK,
    evidence_snapshots: [
      { observed_at: '2026-08-17T00:00:00Z', impressions: 40, position: 6 },
      { observed_at: '2026-08-24T00:00:00Z', impressions: 55, position: 5 },
    ],
  };
}

const ship = () => qualifyAndShipContentGaps(1, { id: 1, timezone: 'UTC' }, { now: THIS_MONDAY });

beforeEach(() => { pendingGaps = []; spentToday = 0; statusUpdates = []; draftsGenerated = []; });

describe('qualifyAndShipContentGaps — daily cap', () => {
  test('ships every qualifying gap when well under the cap', async () => {
    pendingGaps = [gap(1), gap(2), gap(3)];
    const result = await ship();
    assert.equal(result.shipped, 3);
    assert.equal(result.deferred, 0);
    assert.equal(draftsGenerated.length, 3);
  });

  test('stops at the daily cap and defers the rest instead of shipping unbounded', async () => {
    pendingGaps = Array.from({ length: 25 }, (_, i) => gap(i + 1));
    const result = await ship();
    assert.equal(result.shipped, 20, 'the default cap is 20/day');
    assert.equal(result.deferred, 5);
    assert.equal(draftsGenerated.length, 20, 'no draft may be generated past the cap');
  });

  test('a deferred gap is NOT marked approved — it stays pending_review so the next run reconsiders it', async () => {
    pendingGaps = Array.from({ length: 22 }, (_, i) => gap(i + 1));
    await ship();
    assert.equal(statusUpdates.length, 20, 'only shipped gaps get their status advanced');
    assert.ok(statusUpdates.every((u) => u.status === 'approved'));
  });

  test('drafts this lane already opened earlier today count against the same cap', async () => {
    spentToday = 18;
    pendingGaps = Array.from({ length: 10 }, (_, i) => gap(i + 1));
    const result = await ship();
    assert.equal(result.shipped, 2, '20 cap minus 18 already spent leaves 2');
    assert.equal(result.deferred, 8);
  });

  test('a lane that already hit its cap today ships nothing at all on a later run', async () => {
    spentToday = 20;
    pendingGaps = [gap(1), gap(2)];
    const result = await ship();
    assert.equal(result.shipped, 0);
    assert.equal(draftsGenerated.length, 0);
    assert.equal(result.deferred, 2);
  });

  test('the cap is reported back so a caller can see the budget, not just the outcome', async () => {
    spentToday = 3;
    pendingGaps = [gap(1)];
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
