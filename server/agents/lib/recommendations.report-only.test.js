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

const { buildRecommendations } = await import('./recommendations.js');

const reportOnlyFinding = {
  id: 'font-consistency:size-outlier',
  evidence: { affectedCount: 5 },
  whyItMatters: '5 elements render at a different font-size than the same element type elsewhere.',
  priority: 'high',
  recommendedAction: null,
  expectedImpact: { label: 'High', basis: 'computed', value: 5 },
  reportOnly: {
    kind: 'font-size-inconsistency',
    label: 'Text renders at an inconsistent size',
    page: 'https://example.com/about/',
    whyBlocked: 'This font-size comes from a shared CSS class, not a per-element override.',
  },
};

// The shape every other agent emits for context rather than for action —
// query-intelligence's "your top query moved", device-intelligence's split.
const evidenceOnlyFinding = {
  id: 'query-intelligence:top-query-shift',
  evidence: { from: 'a', to: 'b' },
  whyItMatters: 'Your top query changed.',
  priority: 'low',
  recommendedAction: null,
  expectedImpact: { label: 'Low', basis: 'computed', value: 1 },
  reportOnly: null,
};

describe('buildRecommendations — report-only findings', () => {
  beforeEach(() => {
    gateCalls = [];
    runs = [];
  });

  test('surfaces a reportOnly finding as a blocked, manual-tier row', async () => {
    runs = [{ agentId: 'font-consistency', createdAt: '2026-09-03T07:00:00Z', findings: [reportOnlyFinding] }];

    const { items } = await buildRecommendations(1);

    assert.equal(items.length, 1);
    const item = items[0];
    assert.equal(item.generatorId, 'font-size-inconsistency');
    assert.equal(item.tag, 'Text renders at an inconsistent size');
    assert.equal(item.params.page, 'https://example.com/about/');
    assert.equal(item.priority, 'high');
    // Carrying a blockedReason is what demotes the row to the manual tier and
    // hides every Generate affordance — without it the row would look
    // draftable and satisfy neither.
    assert.equal(item.blockedReason, 'This font-size comes from a shared CSS class, not a per-element override.');
  });

  test('never runs a draftability gate on a report-only finding', async () => {
    runs = [{ agentId: 'font-consistency', createdAt: '2026-09-03T07:00:00Z', findings: [reportOnlyFinding] }];

    await buildRecommendations(1);

    // A 'drop' verdict from a gate asking about a fix that does not exist
    // would delete a real, confirmed finding for an unrelated reason.
    assert.deepEqual(gateCalls, []);
  });

  test('still drops an evidence-only finding that has no reportOnly', async () => {
    runs = [{ agentId: 'query-intelligence', createdAt: '2026-09-03T07:00:00Z', findings: [evidenceOnlyFinding] }];

    const { items } = await buildRecommendations(1);

    // The whole reason reportOnly is opt-in: surfacing every actionless
    // finding would bury the actionable list under context rows.
    assert.deepEqual(items, []);
  });

  test('marks the report-only row detected so it is not auto-closed as stale', async () => {
    runs = [{ agentId: 'font-consistency', createdAt: '2026-09-03T07:00:00Z', findings: [reportOnlyFinding] }];

    const { detectedKeys } = await buildRecommendations(1);

    // Absent from detectedKeys, closeStaleRecommendations would close the row
    // on the very next sync — the agent re-detects it every run, so it would
    // reopen, giving a permanent open/close flap.
    assert.ok([...detectedKeys].some((k) => k.startsWith('font-size-inconsistency::')));
  });
});
