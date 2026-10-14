import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// The weekly Growth Opportunities -> Action Center sync (job.js's
// runGrowthOpportunitiesSyncForAllSites, cron.js's Monday-only schedule) —
// the bulk counterpart to a staff member clicking "Send to Action Center" on
// each Growth Opportunities row one at a time. Same mocking discipline as
// analyst-sync.test.js: narrow mocks only, real page-key/gate logic left to
// their own test files.

let inserted;
let openRecommendation;
let opportunities;

mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    findOpenRecommendation: async () => openRecommendation,
    insertRecommendation: async (siteId, rec) => { inserted.push({ siteId, ...rec }); return { id: inserted.length }; },
    refreshRecommendationBlockState: async () => null,
  },
});

mock.module(resolve('./recommendation-coordinator.js'), {
  namedExports: {
    recommendationPageKey: ({ params }) => params?.page || params?.topic || '',
  },
});

// Same "must never draft" contract as the nightly analyst sync: an
// unattended pass creates recommendations only, so the risk-tier gate still
// decides what may ship without a human.
mock.module(resolve('../../routes/action-center.js'), {
  namedExports: {
    generateDraft: async () => { throw new Error('the sync must never draft — drafting stays gated behind risk tier'); },
  },
});

mock.module(resolve('../../llm.js'), {
  namedExports: {
    callLLM: async () => { throw new Error('these tests do not exercise LLM calls'); },
    callLLMForJson: async () => { throw new Error('these tests do not exercise LLM-backed gap classification'); },
  },
});

mock.module(resolve('./growth-opportunities.js'), {
  namedExports: {
    buildGrowthOpportunities: async () => ({ opportunities }),
  },
});

const { syncGrowthOpportunitiesToActionCenter } = await import('./analyst-seo-mapping.js');

const SITE = { id: 7, website_domain: 'client.example', url_file_map: {} };

function opp(overrides = {}) {
  return {
    type: 'quick-win',
    query: 'gaas company',
    page: 'https://client.example/gaas',
    severity: 'high',
    reason: 'Ranks #3.4 with 60 impressions, but CTR is well below expected.',
    ...overrides,
  };
}

beforeEach(() => {
  inserted = [];
  openRecommendation = null;
  opportunities = [];
});

describe('syncGrowthOpportunitiesToActionCenter', () => {
  test('creates a recommendation from an eligible opportunity', async () => {
    opportunities = [opp()];
    const result = await syncGrowthOpportunitiesToActionCenter(7, { site: SITE });
    assert.equal(result.created, 1);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].recommendationType, 'meta-title');
    assert.equal(inserted[0].detectingAgent, 'growth-opportunities');
    assert.match(inserted[0].issue, /"gaas company"/);
    assert.equal(inserted[0].priority, 'high');
  });

  test('NEVER drafts — drafting stays behind the risk-tier gate', async () => {
    opportunities = [opp()];
    await syncGrowthOpportunitiesToActionCenter(7, { site: SITE });
    assert.equal(inserted.length, 1);
  });

  test('content-gap opportunities are skipped — they have their own approval path', async () => {
    opportunities = [opp({ type: 'content-gap', query: 'some gap topic' })];
    const result = await syncGrowthOpportunitiesToActionCenter(7, { site: SITE });
    assert.equal(result.created, 0);
    assert.equal(result.ineligible, 1);
    assert.deepEqual(inserted, []);
  });

  test('is idempotent — an existing open recommendation is skipped, not duplicated', async () => {
    opportunities = [opp()];
    openRecommendation = { id: 99 };
    const result = await syncGrowthOpportunitiesToActionCenter(7, { site: SITE });
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(inserted, []);
  });

  test('an opportunity with no query (content-expansion cluster) still gets a sensible issue text', async () => {
    opportunities = [opp({ type: 'content-expansion', query: null })];
    await syncGrowthOpportunitiesToActionCenter(7, { site: SITE });
    assert.match(inserted[0].issue, /content-expansion.*client\.example\/gaas/);
  });

  test('processes a mixed batch without letting one ineligible item stop the rest', async () => {
    opportunities = [
      opp({ type: 'content-gap' }),
      opp({ type: 'declining', query: 'other keyword' }),
    ];
    const result = await syncGrowthOpportunitiesToActionCenter(7, { site: SITE });
    assert.equal(result.created, 1);
    assert.equal(result.ineligible, 1);
  });

  test('an empty batch is a no-op, not an error', async () => {
    opportunities = [];
    const result = await syncGrowthOpportunitiesToActionCenter(7, { site: SITE });
    assert.equal(result.created, 0);
    assert.deepEqual(inserted, []);
  });
});
