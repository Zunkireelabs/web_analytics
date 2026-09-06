import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// recheckRecommendation's own module transitively pulls in the same heavy
// chain recommendation-coordinator-refresh.test.js works around
// (recommendation-gates.js -> github/client.js -> ... -> runner.js -> llm.js
// -> openai). Every collaborator is mocked narrowly so that chain is never
// actually reached.
let recById, mergedCalls, closedIds, recheckLinkImpl, runAgentImpl, siteById;

mock.module(new URL('../../store/recommendations.js', import.meta.url).href, {
  namedExports: {
    findOpenRecommendation: async () => null,
    insertRecommendation: async () => { throw new Error('must not be reached'); },
    mergeIntoRecommendation: async (id, patch) => { mergedCalls.push({ id, ...patch }); return { id, ...patch }; },
    refreshRecommendationBlockState: async () => { throw new Error('must not be reached'); },
    listOpenRecommendations: async () => [],
    listOpenBlockedRecommendations: async () => [],
    closeStaleRecommendations: async () => 0,
    markRecommendationsUnfixable: async () => 0,
    getRecommendationById: async () => recById,
    closeRecommendation: async (id) => { closedIds.push(id); },
  },
});
mock.module(new URL('../../store/drafts.js', import.meta.url).href, { namedExports: {
  getDraftedFindingIds: async () => new Set(),
  getLiveDraftsByFindingId: async () => new Map(),
} });
mock.module(new URL('../../store/recommendation-attempts.js', import.meta.url).href, { namedExports: {
  attemptSummaryByFinding: async () => new Map(),
} });
mock.module(new URL('./command-center.js', import.meta.url).href, { namedExports: { categoryByAgentId: async () => new Map() } });
mock.module(new URL('../runner.js', import.meta.url).href, { namedExports: { runAgent: async (...args) => runAgentImpl(...args) } });
mock.module(new URL('../../store/read.js', import.meta.url).href, { namedExports: { getSiteById: async () => siteById } });
mock.module(new URL('./recommendation-gates.js', import.meta.url).href, {
  namedExports: { createRecommendationGates: () => ({ evaluate: async () => ({ drop: null, blockedReason: null }) }) },
});
mock.module(new URL('./technical-seo-analysis.js', import.meta.url).href, {
  namedExports: { recheckLink: async (href) => recheckLinkImpl(href) },
});

const { recheckRecommendation } = await import('./recommendation-coordinator.js');

const PAGE = 'https://zunkireelabs.com/services/ai-ecommerce/';

beforeEach(() => {
  mergedCalls = [];
  closedIds = [];
  siteById = { id: 1, timezone: 'UTC' };
  recById = null;
  recheckLinkImpl = () => { throw new Error('must not be reached'); };
  runAgentImpl = () => { throw new Error('must not be reached'); };
});

describe('recheckRecommendation — existing behavior is unchanged when refreshEvidence is omitted', () => {
  test('a non-open recommendation is returned as-is, nothing touched', async () => {
    recById = { id: 1, status: 'superseded' };
    const result = await recheckRecommendation(1, 1);
    assert.deepEqual(result, { status: 'superseded', changed: false });
    assert.equal(mergedCalls.length, 0);
  });

  test('broken-link-fix: still broken leaves it open, unchanged, no merge attempted', async () => {
    recById = { id: 2, status: 'open', recommendation_type: 'broken-link-fix', params: { href: 'https://dead.example/' } };
    recheckLinkImpl = () => ({ broken: true });
    const result = await recheckRecommendation(1, 2, { refreshEvidence: true });
    assert.deepEqual(result, { status: 'open', changed: false, detail: { broken: true } });
    assert.equal(mergedCalls.length, 0, 'broken-link-fix has no fresh params to merge — the href itself was just reconfirmed');
  });

  test('broken-link-fix: no longer broken closes it', async () => {
    recById = { id: 3, status: 'open', recommendation_type: 'broken-link-fix', params: { href: 'https://fixed.example/' } };
    recheckLinkImpl = () => ({ broken: false });
    const result = await recheckRecommendation(1, 3);
    assert.deepEqual(result, { status: 'superseded', changed: true, detail: { broken: false } });
    assert.deepEqual(closedIds, [3]);
  });

  test('still detected, refreshEvidence omitted (default false): stays open, no merge — the original "Re-check now" button behavior', async () => {
    recById = { id: 4, status: 'open', recommendation_type: 'alt-text', page: PAGE, detecting_agents: ['ai-visibility'], finding_ids: ['content-gap:...:Missing alt text'], params: { page: PAGE, anchor: 'STALE ANCHOR' } };
    runAgentImpl = async () => ({ facts: { findings: [{ recommendedAction: { generatorId: 'alt-text', params: { page: PAGE, anchor: 'FRESH ANCHOR' } } }] } });
    const result = await recheckRecommendation(1, 4);
    assert.deepEqual(result, { status: 'open', changed: false });
    assert.equal(mergedCalls.length, 0, 'default behavior must not silently start refreshing params for the manual UI button');
  });

  test('no longer detected: closes as superseded regardless of refreshEvidence', async () => {
    recById = { id: 5, status: 'open', recommendation_type: 'alt-text', page: PAGE, detecting_agents: ['ai-visibility'], finding_ids: ['f5'], params: { page: PAGE } };
    runAgentImpl = async () => ({ facts: { findings: [] } });
    const result = await recheckRecommendation(1, 5, { refreshEvidence: true });
    assert.deepEqual(result, { status: 'superseded', changed: true });
    assert.deepEqual(closedIds, [5]);
    assert.equal(mergedCalls.length, 0, 'resolved — nothing left to refresh params for');
  });
});

describe('recheckRecommendation — refreshEvidence: true (the autonomous-recovery path)', () => {
  test('still detected: merges the FRESH params from re-detection, preserving finding identity', async () => {
    recById = {
      id: 4387, status: 'open', recommendation_type: 'alt-text', page: PAGE,
      detecting_agents: ['ai-visibility'], finding_ids: ['content-gap:.../services/ai-ecommerce/:Missing alt text'],
      params: { page: PAGE, targetSrc: '/img/old-hero.png' },
    };
    runAgentImpl = async () => ({ facts: { findings: [
      { recommendedAction: { generatorId: 'alt-text', params: { page: PAGE, targetSrc: '/img/new-hero.png' } } },
    ] } });

    const result = await recheckRecommendation(1, 4387, { refreshEvidence: true });

    assert.equal(result.status, 'open');
    assert.equal(result.changed, true);
    assert.equal(result.refreshed, true);
    assert.deepEqual(result.freshParams, { page: PAGE, targetSrc: '/img/new-hero.png' });
    assert.equal(mergedCalls.length, 1);
    assert.equal(mergedCalls[0].id, 4387);
    assert.deepEqual(mergedCalls[0].params, { page: PAGE, targetSrc: '/img/new-hero.png' });
    // The SAME finding_id already on the row — union with itself, never a
    // new identity and never a second recommendation.
    assert.equal(mergedCalls[0].findingId, 'content-gap:.../services/ai-ecommerce/:Missing alt text');
    assert.equal(mergedCalls[0].blockedReason, null);
    assert.equal(mergedCalls[0].riskTier, 'safe'); // riskTierForGenerator('alt-text')
  });

  test('site-level recommendations are never touched — no page to re-detect against', async () => {
    recById = { id: 6, status: 'open', recommendation_type: 'llms-txt', page: '', detecting_agents: ['technical-seo'], params: {} };
    const result = await recheckRecommendation(1, 6, { refreshEvidence: true });
    assert.equal(result.changed, false);
    assert.equal(mergedCalls.length, 0);
  });

  test('a live-agent error leaves the recommendation untouched, not merged with garbage', async () => {
    recById = { id: 7, status: 'open', recommendation_type: 'alt-text', page: PAGE, detecting_agents: ['ai-visibility'], finding_ids: ['f7'], params: { page: PAGE } };
    runAgentImpl = async () => { throw new Error('boom'); };
    const result = await recheckRecommendation(1, 7, { refreshEvidence: true });
    assert.equal(result.status, 'open');
    assert.equal(result.changed, false);
    assert.equal(mergedCalls.length, 0);
  });
});
