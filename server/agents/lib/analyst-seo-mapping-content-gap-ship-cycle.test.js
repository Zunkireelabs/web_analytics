import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// qualifyAndShipContentGaps (analyst-seo-mapping.js) is the weekly Monday
// autonomous half of content-gap shipping: it must NEVER qualify a gap that
// hasn't survived at least one re-observation (observation_count >= 2), that
// isn't relevant to a real product ('unrelated' never qualifies), whose real
// GSC demand dropped between its two most recent weekly snapshots, or that
// was discovered by THIS week's own discovery pass rather than last week's.
// All four gates are exercised here via dryRun:true, which never calls
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
  namedExports: {
    callLLM: async () => { throw new Error('these tests do not exercise LLM calls'); },
    callLLMForJson: async () => { throw new Error('not exercised by this test file'); } },
});
mock.module(resolve('../../routes/action-center.js'), {
  namedExports: { generateDraft: async () => { throw new Error('dryRun must never generate a draft'); } },
});
mock.module(resolve('./recommendation-coordinator.js'), {
  namedExports: { recommendationPageKey: () => { throw new Error('dryRun must never write a recommendation'); } },
});

const { qualifyAndShipContentGaps, hasStableOrGrowingDemand, isoWeekStart } = await import('./analyst-seo-mapping.js');

// The Monday this suite pretends "now" is. Every gap below is attributed to
// an EARLIER week by default, i.e. the previous week's discovery cycle — the
// only cohort a Monday ship pass is ever allowed to act on.
const THIS_MONDAY = new Date('2026-08-31T00:00:00Z');
// Old enough to clear the 2-week gather window (qualifyAndShipContentGaps
// requires first_discovery_week to be at least 2 full weeks before `now`) —
// named LAST_WEEK for historical reasons but no longer literally last week.
const LAST_WEEK = '2026-08-17';

function baseGap(overrides = {}) {
  return {
    id: 1, topic: 'ai booking engine nepal', reason: null, priority: 'medium', status: 'pending_review',
    search_intent: 'commercial', product_relevance: 'direct', existing_page_match: null,
    observation_count: 2,
    // 'YYYY-MM-DD' strings, matching getKeywordGaps's ::text cast — see the
    // comment on that query for why these are never Date objects.
    first_discovery_week: LAST_WEEK,
    last_observed_week: LAST_WEEK,
    evidence_snapshots: [
      { observed_at: '2026-08-17T00:00:00Z', impressions: 40, position: 6 },
      { observed_at: '2026-08-24T00:00:00Z', impressions: 55, position: 5 },
    ],
    ...overrides,
  };
}

// Every call pins `now` so these tests describe a fixed Monday rather than
// silently changing behavior depending on the day the suite happens to run.
const dry = () => qualifyAndShipContentGaps(1, { id: 1 }, { dryRun: true, now: THIS_MONDAY });

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
    const result = await dry();
    assert.equal(result.candidates, 0);
    assert.equal(result.shipped, 0);
  });

  test('an "unrelated" product_relevance gap never auto-qualifies, even with 2+ growing observations', async () => {
    pendingGaps = [baseGap({ product_relevance: 'unrelated' })];
    const result = await dry();
    assert.equal(result.candidates, 0);
  });

  test('"supporting" product_relevance (not just "direct") is allowed to qualify', async () => {
    pendingGaps = [baseGap({ product_relevance: 'supporting' })];
    const result = await dry();
    assert.equal(result.candidates, 1);
  });

  test('a one-off spike followed by a drop does not qualify', async () => {
    pendingGaps = [baseGap({
      evidence_snapshots: [{ impressions: 90, position: 4 }, { impressions: 8, position: 9 }],
    })];
    const result = await dry();
    assert.equal(result.candidates, 0);
  });

  test('a fully-qualifying, blog-shaped gap is selected and its generator is reported, without shipping (dryRun)', async () => {
    // informational intent (not commercial/transactional) routes to
    // blog-outline, not landing-page — see gapDraftEligibility. This is the
    // shape the biweekly cron is allowed to auto-approve.
    pendingGaps = [baseGap({ search_intent: 'informational' })];
    const result = await dry();
    assert.equal(result.candidates, 1);
    assert.equal(result.shipped, 0, 'dryRun must never actually ship');
    assert.equal(result.results[0].generatorId, 'blog-outline');
    assert.equal(result.results[0].dryRun, true);
  });

  test('a landing-page-shaped gap is NEVER auto-approved, even when every other gate passes — it needs a human "yes" on the Analyst page first', async () => {
    // baseGap() defaults to commercial + direct relevance, i.e. exactly the
    // combination gapDraftEligibility routes to 'landing-page'.
    pendingGaps = [baseGap()];
    const result = await dry();
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
    const result = await dry();
    assert.equal(result.pending, 4);
    assert.equal(result.candidates, 1);
    assert.equal(result.results[0].gapId, 4);
    assert.equal(result.results[0].qualified, true);
  });
});

// The week boundary is what makes the cycle "ship LAST week's, then start
// THIS week's" rather than "ship whatever happens to look ready." Without it,
// a Monday run could ship an opportunity its own sibling job discovered hours
// earlier the same morning — which is precisely the outcome the two-schedule
// design exists to prevent. It is enforced on the DATA (first_discovery_week)
// rather than on job ordering, because the ship pass (Node cron, 00:00 UTC)
// and the discovery pass (Python collector, 03:00 UTC in-process and 22:00
// UTC via a staging host crontab) are independent schedulers in two
// languages; "which one ran first" is not a guarantee anything can rely on.
describe('qualifyAndShipContentGaps — weekly cycle boundary', () => {
  test('a gap discovered by THIS week\'s own discovery pass never ships in the same week', async () => {
    // Same Monday as `now`. Everything else about it is perfect.
    pendingGaps = [baseGap({ search_intent: 'informational', first_discovery_week: '2026-08-31' })];
    const result = await dry();
    assert.equal(result.candidates, 0, 'a same-week discovery must wait for the NEXT Monday');
    assert.equal(result.shipped, 0);
  });

  test('last week\'s discovery has only survived one week-boundary crossing — still held', async () => {
    // The gather window is 2 full weeks: one boundary crossing alone is not enough.
    pendingGaps = [baseGap({ search_intent: 'informational', first_discovery_week: '2026-08-24' })];
    const result = await dry();
    assert.equal(result.candidates, 0);
  });

  test('a gap discovered exactly 2 weeks ago is the cohort this Monday ships', async () => {
    pendingGaps = [baseGap({ search_intent: 'informational', first_discovery_week: '2026-08-17' })];
    const result = await dry();
    assert.equal(result.candidates, 1);
  });

  test('an older backlog gap from several weeks ago still qualifies — the rule is "at least 2 weeks", not "exactly 2 weeks"', async () => {
    pendingGaps = [baseGap({ search_intent: 'informational', first_discovery_week: '2026-06-01' })];
    const result = await dry();
    assert.equal(result.candidates, 1);
  });

  test('a gap with no discovery week attributed at all is held, never shipped on a guess', async () => {
    // A row predating migration 143 whose backfill somehow didn't land. The
    // honest response is to hold it until a real discovery pass attributes
    // it, not to assume it belongs to a shippable week.
    pendingGaps = [baseGap({ search_intent: 'informational', first_discovery_week: null })];
    const result = await dry();
    assert.equal(result.candidates, 0);
  });

  test('the 2-week gather window is applied per gap, not to the whole batch', async () => {
    pendingGaps = [
      baseGap({ id: 10, search_intent: 'informational', first_discovery_week: '2026-08-24' }), // only 1 week old — held
      baseGap({ id: 11, search_intent: 'informational', first_discovery_week: '2026-08-17' }), // 2 weeks old — ships
    ];
    const result = await dry();
    assert.equal(result.candidates, 1);
    assert.equal(result.results[0].gapId, 11);
  });
});

describe('isoWeekStart — must agree with Postgres date_trunc and the Python collector', () => {
  test('a Sunday belongs to the week that began the preceding Monday', () => {
    assert.equal(isoWeekStart(new Date('2026-09-06T00:00:00Z')), '2026-08-31');
  });

  test('a Monday is its own week start', () => {
    assert.equal(isoWeekStart(new Date('2026-08-31T00:00:00Z')), '2026-08-31');
  });

  test('the following Monday rolls into a new week', () => {
    assert.equal(isoWeekStart(new Date('2026-09-07T00:00:00Z')), '2026-09-07');
  });

  test('a late-evening UTC timestamp does not leak into the next week', () => {
    assert.equal(isoWeekStart(new Date('2026-09-06T23:59:59Z')), '2026-08-31');
  });
});
