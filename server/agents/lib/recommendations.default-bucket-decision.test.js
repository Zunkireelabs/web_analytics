import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

let runs;
let site;
let decideImpl;
let decideCalls;

mock.module(resolve('./fresh-runs.js'), {
  namedExports: { getLatestFindings: async () => runs, getLatestAgentRuns: async () => [] },
});
mock.module(resolve('../../store/drafts.js'), {
  namedExports: { getDraftedFindingIds: async () => new Set(), getLiveDraftsByFindingId: async () => new Map() },
});
mock.module(resolve('./command-center.js'), {
  namedExports: { categoryByAgentId: async () => new Map([['some-agent', { name: 'Some Agent' }]]) },
});
mock.module(resolve('../../store/read.js'), {
  namedExports: {
    getSiteById: async () => site,
    getSearchPerformanceRange: async () => [],
    getQueriesForPage: async () => [],
    getDataRange: async () => ({ earliest: null, freshest: null }),
  },
});
mock.module(resolve('./recommendation-gates.js'), {
  namedExports: { createRecommendationGates: () => ({ site: {}, evaluate: async () => ({ drop: null, blockedReason: null }) }) },
});
mock.module(resolve('../../store/site-goals.js'), {
  namedExports: { listActiveGoals: async () => [] },
});
// The only module default-bucket-decision.js itself reaches into for a real
// decide() call — mocked here to exercise buildRecommendations' real wiring
// end-to-end (feature flag -> candidate collection -> decide() -> item
// mutation/suppression -> final items array) without a real LLM/DB call.
mock.module(resolve('./decision-engine.js'), {
  namedExports: { decisionEngine: { decide: async (...args) => { decideCalls.push(args); return decideImpl(...args); } } },
});

const { buildRecommendations } = await import('./recommendations.js');

// generatorId 'genuinely-unmapped-generator' matches nothing in
// recommendation-taxonomy.js's BY_SOURCE_AND_GENERATOR/BY_GENERATOR, so
// classify() falls through to DEFAULT_CLASSIFICATION — the one shape this
// integration is scoped to.
function defaultBucketFinding(overrides = {}) {
  return {
    id: 'some-agent:1', evidence: {}, whyItMatters: 'A genuinely novel finding shape.',
    priority: 'medium', expectedImpact: { label: 'Medium', basis: 'computed', value: 1 },
    reportOnly: null,
    recommendedAction: { generatorId: 'genuinely-unmapped-generator', label: 'Do something new', params: { page: '/weird-page' } },
    ...overrides,
  };
}

describe('buildRecommendations — scoped Decision Engine integration (DEFAULT bucket only)', () => {
  beforeEach(() => {
    runs = [];
    decideCalls = [];
    decideImpl = async () => ({ id: 1, action: 'investigate_further' });
  });

  // Required test 4: flag OFF behaves exactly as before.
  test('flag OFF: DEFAULT-bucket finding passes through unchanged, decide() never called', async () => {
    site = { id: 1, website_domain: 'example.com', decision_engine_default_bucket_enabled: false };
    runs = [{ agentId: 'some-agent', createdAt: '2026-09-29T07:00:00Z', start: '2026-09-22', end: '2026-09-29', findings: [defaultBucketFinding()] }];

    const { items } = await buildRecommendations(1);

    assert.equal(items.length, 1);
    assert.equal(items[0].bucket, 'seo');
    assert.equal(items[0].category, 'Technical Fixes');
    assert.equal(items[0].decisionId, undefined);
    assert.equal(decideCalls.length, 0);
  });

  // Required test 1: do_nothing suppresses the finding from the final output set.
  test('flag ON, do_nothing: the finding is absent from the final items array', async () => {
    site = { id: 1, website_domain: 'example.com', decision_engine_default_bucket_enabled: true };
    runs = [{ agentId: 'some-agent', createdAt: '2026-09-29T07:00:00Z', start: '2026-09-22', end: '2026-09-29', findings: [defaultBucketFinding()] }];
    decideImpl = async () => ({ id: 5, action: 'do_nothing' });

    const { items } = await buildRecommendations(1);

    assert.equal(items.length, 0);
    assert.equal(decideCalls.length, 1);
  });

  // Required test 2: two different valid outputs produce measurably different states.
  test('flag ON, investigate_further: a distinct investigation state is attached, item stays in output', async () => {
    site = { id: 1, website_domain: 'example.com', decision_engine_default_bucket_enabled: true };
    runs = [{ agentId: 'some-agent', createdAt: '2026-09-29T07:00:00Z', start: '2026-09-22', end: '2026-09-29', findings: [defaultBucketFinding()] }];
    decideImpl = async () => ({ id: 8, action: 'investigate_further' });

    const { items } = await buildRecommendations(1);

    assert.equal(items.length, 1);
    assert.equal(items[0].decisionState, 'investigating');
    assert.equal(items[0].decisionId, 8);
  });

  // Required test 3: risk-tier/safety-relevant fields unchanged regardless of output.
  test('flag ON: bucket/category/blockedReason are identical whether decide() returns do_nothing-adjacent or a normal action', async () => {
    site = { id: 1, website_domain: 'example.com', decision_engine_default_bucket_enabled: true };
    runs = [{ agentId: 'some-agent', createdAt: '2026-09-29T07:00:00Z', start: '2026-09-22', end: '2026-09-29', findings: [defaultBucketFinding()] }];
    decideImpl = async () => ({ id: 3, action: 'fix_technical' });

    const { items } = await buildRecommendations(1);

    assert.equal(items[0].bucket, 'seo');
    assert.equal(items[0].category, 'Technical Fixes');
    assert.equal(items[0].blockedReason, null);
  });

  // Non-DEFAULT findings must never reach decide() at all, flag on or off.
  test('a finding the taxonomy explicitly maps never becomes a candidate, even with the flag on', async () => {
    site = { id: 1, website_domain: 'example.com', decision_engine_default_bucket_enabled: true };
    runs = [{
      agentId: 'content-gap', createdAt: '2026-09-29T07:00:00Z', start: '2026-09-22', end: '2026-09-29',
      findings: [{
        id: 'content-gap:1', evidence: {}, whyItMatters: 'Meta title missing.', priority: 'medium',
        expectedImpact: { label: 'Medium', basis: 'computed', value: 1 }, reportOnly: null,
        recommendedAction: { generatorId: 'meta-title', label: 'Write meta title', params: { page: '/a', query: 'already grounded' } },
      }],
    }];

    const { items } = await buildRecommendations(1);

    assert.equal(items.length, 1);
    assert.equal(decideCalls.length, 0);
  });

  // Required test 6: multiple DEFAULT findings still respect the cap.
  test('flag ON, more DEFAULT findings than the cap: still bounded, later ones fall through untouched', async () => {
    site = { id: 1, website_domain: 'example.com', decision_engine_default_bucket_enabled: true };
    const findings = Array.from({ length: 3 }, (_, i) => defaultBucketFinding({ id: `some-agent:${i}`, recommendedAction: { generatorId: 'genuinely-unmapped-generator', label: 'x', params: { page: `/p${i}` } } }));
    runs = [{ agentId: 'some-agent', createdAt: '2026-09-29T07:00:00Z', start: '2026-09-22', end: '2026-09-29', findings }];
    decideImpl = async () => ({ id: 1, action: 'improve_page' });

    const { items } = await buildRecommendations(1);

    assert.equal(items.length, 3, 'all three still present — only do_nothing removes items');
    assert.equal(decideCalls.length, 3, 'within the default cap (5) — all three called');
  });
});
