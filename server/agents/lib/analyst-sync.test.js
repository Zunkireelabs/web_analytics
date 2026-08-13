import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// The 3am Analyst pipeline already collected, forecast and produced insights
// every night — including forecast_risk insights that predict a decline
// before it appears in reporting — and none of it reached the Action Center.
// The only path was a human approving one item at a time. These cover the
// sync that closes that gap, and the widened insight -> generator mapping.

let inserted;
let openRecommendation;

// Every mock here is NARROW on purpose. Spreading a real module back in
// re-triggers its whole import graph under node:test's module mocking, and
// two of these reach code that cannot load that way:
//   - recommendation-coordinator.js imports runAgent, which loads the entire
//     agent registry and, through llm.js -> openai, a transitive dependency
//     (formdata-node/web-streams-polyfill) that fails to instantiate here.
//   - routes/action-center.js reaches the same dependency, which is why every
//     other test in this repo stubs it rather than importing it.
// The real page-key logic stays covered by recommendation-coordinator.test.js.
mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    findOpenRecommendation: async () => openRecommendation,
    insertRecommendation: async (siteId, rec) => { inserted.push({ siteId, ...rec }); return { id: inserted.length }; },
  },
});

mock.module(resolve('./recommendation-coordinator.js'), {
  namedExports: {
    // Mirrors the real key for the page-based generators these tests use.
    recommendationPageKey: ({ params }) => params?.page || params?.topic || '',
  },
});

// Throws so any attempt to draft from the sync fails loudly — see the
// "NEVER drafts" test. store/read.js is deliberately NOT mocked: every test
// passes `site` explicitly, so getSiteById is never reached.
mock.module(resolve('../../routes/action-center.js'), {
  namedExports: {
    generateDraft: async () => { throw new Error('the sync must never draft — drafting stays gated behind risk tier'); },
  },
});

const { syncAnalystInsightsToActionCenter, seoDraftEligibility } = await import('./analyst-seo-mapping.js');

const SITE = { id: 7, website_domain: 'client.example', url_file_map: {} };

function insight(overrides = {}) {
  return {
    metric_key: 'gsc_impressions',
    insight_type: 'trend_shift',
    dimension_type: 'page',
    dimension_value: 'https://client.example/guide',
    period_start: '2026-08-01',
    evidence: { pct_change: -32 },
    ...overrides,
  };
}

beforeEach(() => {
  inserted = [];
  openRecommendation = null;
});

describe('seoDraftEligibility — the mapping is no longer one-generator', () => {
  test('falling impressions -> expand-content (a coverage problem)', () => {
    assert.equal(seoDraftEligibility(SITE, insight()).generatorId, 'expand-content');
  });

  test('falling CTR -> meta-title (seen but not clicked is a presentation problem)', () => {
    const action = seoDraftEligibility(SITE, insight({ metric_key: 'gsc_ctr' }));
    assert.equal(action.generatorId, 'meta-title');
    assert.ok(action.params.query, 'meta-title needs a query param to be draftable');
  });

  test('falling clicks -> meta-title', () => {
    assert.equal(seoDraftEligibility(SITE, insight({ metric_key: 'gsc_clicks' })).generatorId, 'meta-title');
  });

  test('worsening position -> qa-content (answer the query more directly)', () => {
    assert.equal(seoDraftEligibility(SITE, insight({ metric_key: 'gsc_position' })).generatorId, 'qa-content');
  });

  test('a non-decline is still ineligible whatever the metric', () => {
    assert.equal(seoDraftEligibility(SITE, insight({ evidence: { pct_change: 12 } })), null);
  });

  test('a non-page dimension is still ineligible', () => {
    assert.equal(seoDraftEligibility(SITE, insight({ dimension_type: 'device' })), null);
  });

  test('a non-GSC metric is still ineligible', () => {
    assert.equal(seoDraftEligibility(SITE, insight({ metric_key: 'ga4_sessions' })), null);
  });

  test('findingId is deterministic — the idempotency check depends on it', () => {
    assert.equal(seoDraftEligibility(SITE, insight()).findingId, seoDraftEligibility(SITE, insight()).findingId);
  });
});

describe('syncAnalystInsightsToActionCenter', () => {
  test('creates a recommendation from an eligible nightly insight', async () => {
    const result = await syncAnalystInsightsToActionCenter(7, [insight()], { site: SITE });
    assert.equal(result.created, 1);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].recommendationType, 'expand-content');
    assert.equal(inserted[0].detectingAgent, 'analyst-insights');
  });

  test('NEVER drafts — drafting stays behind the risk-tier gate', async () => {
    // generateDraft is mocked to throw. The sync completing proves it was
    // never called: analyst findings must not get a parallel autonomy path
    // that bypasses the gate deciding what may ship unattended.
    await syncAnalystInsightsToActionCenter(7, [insight()], { site: SITE });
    assert.equal(inserted.length, 1);
  });

  test('a predicted (forecast_risk) issue is labelled as predicted, not observed', async () => {
    // A human reading the Action Center needs to know whether this already
    // happened or is about to.
    await syncAnalystInsightsToActionCenter(7, [insight({ insight_type: 'forecast_risk' })], { site: SITE });
    assert.match(inserted[0].issue, /^Predicted/);
    assert.match(inserted[0].reason, /forecast projects/i);
    assert.equal(inserted[0].priority, 'medium', 'a prediction ranks below an observed decline');
  });

  test('an observed decline is labelled detected and ranks higher', async () => {
    await syncAnalystInsightsToActionCenter(7, [insight()], { site: SITE });
    assert.match(inserted[0].issue, /^Detected/);
    assert.equal(inserted[0].priority, 'high');
  });

  test('carries the real evidence into the reason', async () => {
    await syncAnalystInsightsToActionCenter(7, [insight()], { site: SITE });
    assert.match(inserted[0].reason, /-32% change/);
  });

  test('is idempotent — an existing open recommendation is skipped, not duplicated', async () => {
    openRecommendation = { id: 99 };
    const result = await syncAnalystInsightsToActionCenter(7, [insight()], { site: SITE });
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(inserted, []);
  });

  test('ineligible insights are counted, never inserted', async () => {
    const result = await syncAnalystInsightsToActionCenter(7, [
      insight({ dimension_type: 'site' }),
      insight({ metric_key: 'ga4_users' }),
    ], { site: SITE });
    assert.equal(result.created, 0);
    assert.equal(result.ineligible, 2);
    assert.deepEqual(inserted, []);
  });

  test('processes a mixed night without letting one ineligible item stop the rest', async () => {
    const result = await syncAnalystInsightsToActionCenter(7, [
      insight({ dimension_type: 'site' }),
      insight({ metric_key: 'gsc_ctr' }),
      insight(),
    ], { site: SITE });
    assert.equal(result.created, 2);
    assert.equal(result.ineligible, 1);
  });

  test('an empty night is a no-op, not an error', async () => {
    const empty = { created: 0, skipped: 0, ineligible: 0, dropped: 0, blocked: 0 };
    assert.deepEqual(await syncAnalystInsightsToActionCenter(7, [], { site: SITE }), empty);
    assert.deepEqual(await syncAnalystInsightsToActionCenter(7, null, { site: SITE }), empty);
  });
});
