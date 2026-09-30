import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Coverage for syncFromGrounded's goal_id/goal_alignment passthrough (Stage 1
// of the Business Goals plan) — buildRecommendations (agents/lib/
// recommendations.js) computes goalId/goalAlignment per item; this is the
// one place that must carry those two fields into insertRecommendation/
// mergeIntoRecommendation unconditionally (not COALESCE'd), same discipline
// blockedReason/riskTier already use, so a paused goal clears a stale
// alignment on the very next sync.

const resolve = (p) => new URL(p, import.meta.url).href;

let inserted;
let merged;
let existingRec;

mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    findOpenRecommendation: async () => existingRec,
    insertRecommendation: async (siteId, params) => { inserted.push({ siteId, ...params }); return { id: 1, ...params }; },
    mergeIntoRecommendation: async (id, params) => { merged.push({ id, ...params }); return { id, ...params }; },
    refreshRecommendationBlockState: async () => null,
    listOpenRecommendations: async () => [],
    listOpenBlockedRecommendations: async () => [],
    closeStaleRecommendations: async () => {},
    markRecommendationsUnfixable: async () => {},
    getRecommendationById: async () => null,
    closeRecommendation: async () => {},
  },
});
mock.module(resolve('./risk-tiers.js'), { namedExports: { riskTierForGenerator: () => 'safe' } });
mock.module(resolve('../../store/admin/audit-log.js'), { namedExports: { recordAuditEvent: async () => {} } });
// The rest of recommendation-coordinator.js's top-level imports, mocked
// purely to keep module load light — syncFromGrounded itself never calls
// these (they back OTHER exports in the same file, e.g. recheckRecommendation),
// but ES module loading still pulls in their real transitive dependency
// graphs (github/client.js, runner.js's full agent/generator registry) unless
// stubbed, which is unrelated cost this file's tests shouldn't pay.
mock.module(resolve('../../store/drafts.js'), { namedExports: { getLiveDraftsByFindingId: async () => new Map() } });
mock.module(resolve('../../store/recommendation-attempts.js'), { namedExports: { attemptSummaryByFinding: async () => new Map() } });
mock.module(resolve('./command-center.js'), { namedExports: { categoryByAgentId: async () => new Map() } });
mock.module(resolve('./recommendation-gates.js'), { namedExports: { createRecommendationGates: () => ({ evaluate: async () => ({ drop: null, blockedReason: null }) }) } });
mock.module(resolve('./technical-seo-analysis.js'), { namedExports: { recheckLink: async () => ({}) } });
mock.module(resolve('../../store/read.js'), { namedExports: { getSiteById: async () => ({ id: 1 }) } });
mock.module(resolve('../../util/dates.js'), { namedExports: { daysAgoInTz: () => new Date().toISOString() } });
mock.module(resolve('../runner.js'), { namedExports: { runAgent: async () => ({}) } });
mock.module(resolve('../../lib/errors.js'), { namedExports: { safeMessage: (e) => String(e) } });
mock.module(resolve('./insights.js'), { namedExports: { RECOMMENDATION_AGENT_IDS: [] } });

const { syncFromGrounded } = await import('./recommendation-coordinator.js');

beforeEach(() => { inserted = []; merged = []; existingRec = null; });

function item(overrides = {}) {
  return {
    id: 'f1', generatorId: 'meta-title', source: 'query-intelligence',
    reason: 'x', params: { page: '/booking-software/pricing' }, priority: 'medium',
    expectedImpact: null, goalId: null, goalAlignment: null,
    ...overrides,
  };
}

describe('syncFromGrounded — goal_id/goal_alignment passthrough on INSERT', () => {
  test('passes a real alignment through to insertRecommendation', async () => {
    await syncFromGrounded(1, { items: [item({ goalId: 5, goalAlignment: { level: 'strong', rationale: 'r' } })] });
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].goalId, 5);
    assert.deepEqual(inserted[0].goalAlignment, { level: 'strong', rationale: 'r' });
  });

  test('passes null through when the site has no active goals', async () => {
    await syncFromGrounded(1, { items: [item()] });
    assert.equal(inserted[0].goalId, null);
    assert.equal(inserted[0].goalAlignment, null);
  });
});

describe('syncFromGrounded — goal_id/goal_alignment passthrough on MERGE, unconditional not COALESCE', () => {
  test('passes a real alignment through to mergeIntoRecommendation', async () => {
    existingRec = { id: 99, status: 'open', blocked_reason: null };
    await syncFromGrounded(1, { items: [item({ goalId: 7, goalAlignment: { level: 'partial', rationale: 'r2' } })] });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].goalId, 7);
    assert.deepEqual(merged[0].goalAlignment, { level: 'partial', rationale: 'r2' });
  });

  test('a goal that no longer aligns (e.g. paused) is passed as null, clearing the prior alignment', async () => {
    existingRec = { id: 99, status: 'open', blocked_reason: null };
    // Simulates: this recommendation was 'strong' aligned yesterday, but the
    // goal was paused since — buildRecommendations recomputed goalId/
    // goalAlignment as null this run, and that must overwrite the row, not
    // be skipped as "no new value provided".
    await syncFromGrounded(1, { items: [item({ goalId: null, goalAlignment: null })] });
    assert.equal(merged[0].goalId, null);
    assert.equal(merged[0].goalAlignment, null);
  });
});
