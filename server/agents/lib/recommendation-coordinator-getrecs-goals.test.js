import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Coverage for getRecommendations' goal_alignment read-side passthrough (Stage
// 2c of the Business Goals plan). Stage 1 already covers the WRITE side
// (recommendation-coordinator-goals.test.js: syncFromGrounded persists
// goal_id/goal_alignment onto the recommendations row). This is the other
// half: the row's goal_alignment must actually reach the shaped item the UI
// renders, or ActionCenter's "why this matters to your goal" card has
// nothing to show no matter how correct the evaluator is.

const resolve = (p) => new URL(p, import.meta.url).href;

let rows;

mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    listOpenRecommendations: async () => rows,
    findOpenRecommendation: async () => null,
    insertRecommendation: async () => ({ id: 1 }),
    mergeIntoRecommendation: async () => {},
    refreshRecommendationBlockState: async () => null,
    listOpenBlockedRecommendations: async () => [],
    closeStaleRecommendations: async () => {},
    markRecommendationsUnfixable: async () => {},
    getRecommendationById: async () => null,
    closeRecommendation: async () => {},
  },
});
mock.module(resolve('../../store/drafts.js'), { namedExports: { getLiveDraftsByFindingId: async () => new Map() } });
mock.module(resolve('../../store/recommendation-attempts.js'), { namedExports: { attemptSummaryByFinding: async () => new Map() } });
mock.module(resolve('./command-center.js'), { namedExports: { categoryByAgentId: async () => new Map() } });
mock.module(resolve('./risk-tiers.js'), { namedExports: { riskTierForGenerator: () => 'safe' } });
mock.module(resolve('../../store/admin/audit-log.js'), { namedExports: { recordAuditEvent: async () => {} } });
mock.module(resolve('./recommendation-gates.js'), { namedExports: { createRecommendationGates: () => ({ evaluate: async () => ({ drop: null, blockedReason: null }) }) } });
mock.module(resolve('./technical-seo-analysis.js'), { namedExports: { recheckLink: async () => ({}) } });
mock.module(resolve('../../store/read.js'), { namedExports: { getSiteById: async () => ({ id: 1 }) } });
mock.module(resolve('../../util/dates.js'), { namedExports: { daysAgoInTz: () => new Date().toISOString() } });
mock.module(resolve('../runner.js'), { namedExports: { runAgent: async () => ({}) } });
mock.module(resolve('../../lib/errors.js'), { namedExports: { safeMessage: (e) => String(e) } });
mock.module(resolve('./insights.js'), { namedExports: { RECOMMENDATION_AGENT_IDS: [] } });

const { getRecommendations } = await import('./recommendation-coordinator.js');

function row(overrides = {}) {
  return {
    id: 1, page: '/pricing', recommendation_type: 'meta-title', issue: 'x',
    reason: 'r', params: {}, finding_ids: ['f1'], detecting_agents: ['query-intelligence'],
    supporting_agents: [], priority: 'medium', expected_impact: null, risk_tier: 'safe',
    blocked_reason: null, blocked_kind: null, confidence: null,
    goal_alignment: null, last_seen_at: null,
    ...overrides,
  };
}

beforeEach(() => { rows = []; });

describe('getRecommendations — goal_alignment read-side passthrough', () => {
  test('a row with a real alignment carries {level, rationale} onto the shaped item', async () => {
    rows = [row({ goal_alignment: { level: 'strong', rationale: 'On a target page for goal "Grow bookings".' } })];
    const { items } = await getRecommendations(1);
    assert.deepEqual(items[0].goalAlignment, { level: 'strong', rationale: 'On a target page for goal "Grow bookings".' });
  });

  test('a row with no alignment (no active goals) carries null, not undefined', async () => {
    rows = [row({ goal_alignment: null })];
    const { items } = await getRecommendations(1);
    assert.equal(items[0].goalAlignment, null);
  });
});
