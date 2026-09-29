import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

let runs;
let activeGoals;

mock.module(resolve('./fresh-runs.js'), {
  namedExports: { getLatestFindings: async () => runs, getLatestAgentRuns: async () => [] },
});
mock.module(resolve('../../store/drafts.js'), {
  namedExports: { getDraftedFindingIds: async () => new Set(), getLiveDraftsByFindingId: async () => new Map() },
});
mock.module(resolve('./command-center.js'), {
  namedExports: { categoryByAgentId: async () => new Map([['content-gap', { name: 'Content Gap Agent' }]]) },
});
mock.module(resolve('../../store/read.js'), {
  namedExports: {
    getSiteById: async () => ({ id: 1, website_domain: 'example.com' }),
    getSearchPerformanceRange: async () => [],
    getQueriesForPage: async () => [{ query: 'booking software pricing', clicks: 3 }],
    getDataRange: async () => ({ earliest: '2026-01-01', freshest: '2026-09-20' }),
  },
});
mock.module(resolve('./recommendation-gates.js'), {
  namedExports: { createRecommendationGates: () => ({ site: {}, evaluate: async () => ({ drop: null, blockedReason: null }) }) },
});
mock.module(resolve('../../store/site-goals.js'), {
  namedExports: { listActiveGoals: async () => activeGoals },
});

const { buildRecommendations } = await import('./recommendations.js');

function finding(overrides = {}) {
  return {
    id: 'content-gap:1', evidence: {}, whyItMatters: 'Improve booking software content coverage',
    priority: 'medium', expectedImpact: { label: 'Medium', basis: 'computed', value: 2 },
    reportOnly: null,
    recommendedAction: { generatorId: 'faq', label: 'Add FAQ section', params: { page: '/booking-software/pricing' } },
    ...overrides,
  };
}

describe('buildRecommendations — goal alignment integration', () => {
  beforeEach(() => { activeGoals = []; runs = []; });

  test('no active goals -> goalId/goalAlignment are null, unchanged from before this feature existed', async () => {
    runs = [{ agentId: 'content-gap', createdAt: '2026-09-03T07:00:00Z', start: '2026-09-01', end: '2026-09-07', findings: [finding()] }];

    const { items } = await buildRecommendations(1);

    assert.equal(items.length, 1);
    assert.equal(items[0].goalId, null);
    assert.equal(items[0].goalAlignment, null);
  });

  test('an active goal whose target page matches attaches a strong alignment', async () => {
    activeGoals = [{ id: 42, objective: 'Generate leads for booking software', targetBusinessArea: 'booking software', targetPagePatterns: ['/booking-software/*'], description: null, importance: 1 }];
    runs = [{ agentId: 'content-gap', createdAt: '2026-09-03T07:00:00Z', start: '2026-09-01', end: '2026-09-07', findings: [finding()] }];

    const { items } = await buildRecommendations(1);

    assert.equal(items[0].goalId, 42);
    assert.equal(items[0].goalAlignment.level, 'strong');
    assert.match(items[0].goalAlignment.rationale, /target pages/);
  });

  test('an active goal with no relation to the finding attaches "none", the finding is still surfaced', async () => {
    activeGoals = [{ id: 9, objective: 'Reduce bounce on the blog', targetBusinessArea: 'blog content', targetPagePatterns: ['/blog/*'], description: null, importance: 1 }];
    runs = [{ agentId: 'content-gap', createdAt: '2026-09-03T07:00:00Z', start: '2026-09-01', end: '2026-09-07', findings: [finding()] }];

    const { items } = await buildRecommendations(1);

    // Not tied to this active goal, but still a real, surfaced recommendation
    // — goal misalignment must never hide a valid technical finding.
    assert.equal(items.length, 1);
    assert.equal(items[0].goalAlignment.level, 'none');
  });

  test('a report-only finding is also evaluated against active goals (same evaluator, not per-agent logic)', async () => {
    activeGoals = [{ id: 42, objective: 'Generate leads for booking software', targetBusinessArea: 'booking software', targetPagePatterns: ['/booking-software/*'], description: null, importance: 1 }];
    runs = [{
      agentId: 'content-gap', createdAt: '2026-09-03T07:00:00Z', start: '2026-09-01', end: '2026-09-07',
      findings: [{
        id: 'content-gap:2', evidence: {}, whyItMatters: 'x', priority: 'low', expectedImpact: null,
        recommendedAction: null,
        reportOnly: { kind: 'some-issue', label: 'Some issue', page: '/booking-software/features', whyBlocked: 'cannot auto-fix' },
      }],
    }];

    const { items } = await buildRecommendations(1);

    assert.equal(items[0].goalId, 42);
    assert.equal(items[0].goalAlignment.level, 'strong');
  });
});
