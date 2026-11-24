import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

let runs;
let gateCalls;

// buildRecommendations takes only a siteId, so every collaborator is mocked
// at the module boundary — the same approach visual-quality.test.js uses.
mock.module(resolve('./fresh-runs.js'), {
  namedExports: {
    getLatestFindings: async () => runs,
    getLatestAgentRuns: async () => [],
  },
});
mock.module(resolve('../../store/drafts.js'), {
  namedExports: {
    getDraftedFindingIds: async () => new Set(),
    // recommendation-coordinator.js's syncFromGrounded reads this to tell
    // "in progress, PR #N" from "vanished and retryable" — mocked to "no
    // live drafts anywhere", same no-op-collaborator stance as
    // getDraftedFindingIds above; this file tests report-only findings
    // never reaching a draft at all.
    getLiveDraftsByFindingId: async () => new Map(),
  },
});
mock.module(resolve('./command-center.js'), {
  namedExports: { categoryByAgentId: async () => new Map([['font-consistency', { name: 'Font Consistency Agent' }]]) },
});
mock.module(resolve('../../store/read.js'), {
  namedExports: {
    getSiteById: async () => ({ id: 1, website_domain: 'example.com' }),
    getSearchPerformanceRange: async () => [],
    getQueriesForPage: async () => [],
    // makeQueryLookup's widen-before-giving-up step (recommendations.js) —
    // no GSC data at all here, so it must stay a no-op for this file's
    // report-only findings, same as the un-widened getQueriesForPage above.
    getDataRange: async () => ({ earliest: null, freshest: null, latest_visitor: null }),
  },
});
// Records every gate call so the test can assert a report-only finding never
// reaches one — the gates all answer "can we safely draft this?", a question
// that has no meaning for a row nothing will ever draft.
mock.module(resolve('./recommendation-gates.js'), {
  namedExports: {
    createRecommendationGates: () => ({
      site: {},
      evaluate: async (generatorId, params) => {
        gateCalls.push({ generatorId, params });
        return { drop: null, blockedReason: null };
      },
    }),
  },
});
// No active goals for this file's site — goalId/goalAlignment on every item
// must come back null, same "absence means unconfigured" convention as
// every other optional signal here.
mock.module(resolve('../../store/site-goals.js'), {
  namedExports: { listActiveGoals: async () => [] },
});

const { buildRecommendations } = await import('./recommendations.js');


const finding = (id, generatorId, page) => ({
  id, evidence: {}, whyItMatters: 'x', priority: 'medium', expectedImpact: { label: 'Low', basis: 'computed', value: 1 },
  recommendedAction: { label: 'fix', generatorId, params: { page } },
});

describe('buildRecommendations — numbered list pages are fixed at the listing, once', () => {
  beforeEach(() => { gateCalls = []; });

  test('14 page-number schema findings become ONE item on the listing, and the gate sees the listing, not the numbers', async () => {
    const pages = Array.from({ length: 14 }, (_, i) => `https://zunkireelabs.com/blog/articles/page/${i + 2}/`);
    runs = [{ agentId: 'ai-visibility', createdAt: 'T', findings: pages.map((p, i) => finding(`f${i}`, 'schema', p)) }];
    const { items, detectedKeys } = await buildRecommendations(1);
    assert.equal(items.length, 1);
    assert.equal(items[0].generatorId, 'schema');
    assert.equal(items[0].params.page, 'https://zunkireelabs.com/blog/articles/');
    assert.equal(items[0].params.fromNumberedPages, true);
    assert.deepEqual(gateCalls.map((c) => c.params.page), ['https://zunkireelabs.com/blog/articles/']);
    assert.ok([...detectedKeys].some((k) => k.startsWith('schema::') && k.includes('/blog/articles/')), 'the listing stays detected, so its open row is not closed as fixed');
    assert.ok(![...detectedKeys].some((k) => /page\/\d+/.test(k)), 'the old per-page keys are not kept, so their open cards close');
  });

  test('FAQ and Q&A findings on a list page are dropped with the reason on record, and never reach a gate', async () => {
    runs = [{ agentId: 'ai-visibility', createdAt: 'T', findings: [finding('a', 'faq', 'https://zunkireelabs.com/blog/page/4/'), finding('b', 'qa-content', 'https://zunkireelabs.com/de/blog/page/3/')] }];
    const { items, droppedRecommendations } = await buildRecommendations(1);
    assert.deepEqual(items, []);
    assert.equal(droppedRecommendations.length, 2);
    assert.match(droppedRecommendations[0].reason, /numbered page of a list/i);
    assert.deepEqual(gateCalls, []);
  });

  test('a normal page is unaffected', async () => {
    runs = [{ agentId: 'ai-visibility', createdAt: 'T', findings: [finding('a', 'schema', 'https://zunkireelabs.com/services/seo/')] }];
    const { items } = await buildRecommendations(1);
    assert.equal(items.length, 1);
    assert.equal(items[0].params.page, 'https://zunkireelabs.com/services/seo/');
  });
});
