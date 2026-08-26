import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// refreshBlockedRecommendations' own module transitively pulls in the same
// heavy chain recommendation-coordinator-lifecycle.test.js works around
// (recommendation-gates.js -> github/client.js -> ... -> runner.js -> llm.js
// -> openai). Every collaborator is mocked narrowly so that chain is never
// actually reached.
let blockedRows, refreshed, evaluateCalls, evaluateImpl, siteById, listBlockedArgs;

mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    findOpenRecommendation: async () => null,
    insertRecommendation: async () => { throw new Error('must not be reached'); },
    mergeIntoRecommendation: async () => { throw new Error('must not be reached'); },
    refreshRecommendationBlockState: async (id, patch) => { refreshed.push({ id, ...patch }); return { id, ...patch }; },
    listOpenRecommendations: async () => [],
    listOpenBlockedRecommendations: async (siteId, opts) => { listBlockedArgs = { siteId, ...opts }; return blockedRows; },
    closeStaleRecommendations: async () => 0,
    markRecommendationsUnfixable: async () => 0,
    getRecommendationById: async () => null,
    closeRecommendation: async () => {},
  },
});
mock.module(resolve('../../store/drafts.js'), { namedExports: { getDraftedFindingIds: async () => new Set() } });
mock.module(resolve('./command-center.js'), { namedExports: { categoryByAgentId: async () => new Map() } });
mock.module(resolve('../runner.js'), { namedExports: { runAgent: async () => { throw new Error('must not be reached'); } } });
mock.module(resolve('../../store/read.js'), { namedExports: { getSiteById: async () => siteById } });
mock.module(resolve('./recommendation-gates.js'), {
  namedExports: {
    createRecommendationGates: (siteId, site) => ({
      evaluate: async (generatorId, params) => {
        evaluateCalls.push({ siteId, generatorId, params });
        return evaluateImpl(generatorId, params);
      },
    }),
  },
});

const { refreshBlockedRecommendations } = await import('./recommendation-coordinator.js');

beforeEach(() => {
  blockedRows = [];
  refreshed = [];
  evaluateCalls = [];
  listBlockedArgs = null;
  siteById = { id: 1, repo_owner: 'Zunkireelabs', repo_name: 'zunkireelabs-web' };
  evaluateImpl = () => ({ drop: null, blockedReason: null });
});

describe('refreshBlockedRecommendations — a site with no repo connected', () => {
  test('never queries or writes anything', async () => {
    siteById = { id: 2, repo_owner: null, repo_name: null };
    const result = await refreshBlockedRecommendations(2);
    assert.deepEqual(result, { checked: 0, updated: 0 });
    assert.equal(listBlockedArgs, null);
    assert.equal(refreshed.length, 0);
  });
});

describe('refreshBlockedRecommendations — nothing open and blocked', () => {
  test('is a no-op', async () => {
    blockedRows = [];
    const result = await refreshBlockedRecommendations(1);
    assert.deepEqual(result, { checked: 0, updated: 0 });
    assert.equal(refreshed.length, 0);
  });
});

describe('refreshBlockedRecommendations — a blocker whose root cause is now fixed', () => {
  test('clears blocked_reason and restores the generator\'s real risk tier', async () => {
    blockedRows = [{ id: 285, recommendation_type: 'blog-outline', params: { topic: 'Data Privacy and Security in GaaS' }, detecting_agents: ['analyst-keyword-gaps'] }];
    evaluateImpl = () => ({ drop: null, blockedReason: null });

    const result = await refreshBlockedRecommendations(1, { onlyDetectingAgent: 'analyst-keyword-gaps' });

    assert.equal(result.checked, 1);
    assert.equal(result.updated, 1);
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].id, 285);
    assert.equal(refreshed[0].blockedReason, null);
    assert.equal(refreshed[0].riskTier, 'safe'); // riskTierForGenerator('blog-outline')
    assert.equal(listBlockedArgs.onlyDetectingAgent, 'analyst-keyword-gaps');
    assert.equal(listBlockedArgs.excludeDetectingAgent, undefined);
  });
});

describe('refreshBlockedRecommendations — a blocker that is still genuinely blocked', () => {
  test('re-writes the (possibly changed) reason and keeps the manual tier', async () => {
    blockedRows = [{ id: 471, recommendation_type: 'expand-content', params: { page: 'https://zunkireelabs.com/agentic-as-a-service/' }, detecting_agents: ['ai-visibility'] }];
    evaluateImpl = () => ({ drop: null, blockedReason: 'Design Agent setup has failed 5 times in a row.' });

    const result = await refreshBlockedRecommendations(1, { excludeDetectingAgent: 'analyst-keyword-gaps' });

    assert.equal(result.updated, 1);
    assert.equal(refreshed[0].blockedReason, 'Design Agent setup has failed 5 times in a row.');
    assert.equal(refreshed[0].riskTier, 'manual');
    assert.equal(listBlockedArgs.excludeDetectingAgent, 'analyst-keyword-gaps');
  });
});

describe('refreshBlockedRecommendations — the gate could not be evaluated this run', () => {
  test('leaves the row untouched rather than guessing', async () => {
    blockedRows = [{ id: 9, recommendation_type: 'expand-content', params: { page: 'https://x.com/a' }, detecting_agents: ['ai-visibility'] }];
    evaluateImpl = () => { throw new Error('GitHub API unreachable'); };

    const result = await refreshBlockedRecommendations(1);

    assert.equal(result.checked, 1);
    assert.equal(result.updated, 0);
    assert.equal(refreshed.length, 0);
  });
});

describe('refreshBlockedRecommendations — a gate that proves the page is gone (drop)', () => {
  test('is not acted on here — lifecycle closing is out of scope for this pass', async () => {
    blockedRows = [{ id: 12, recommendation_type: 'alt-text', params: { page: 'https://x.com/docs/gone/' }, detecting_agents: ['ai-visibility'] }];
    evaluateImpl = () => ({ drop: 'soft-404', blockedReason: null });

    const result = await refreshBlockedRecommendations(1);

    assert.equal(result.checked, 1);
    // Still gets its block state synced to the gate's own blockedReason
    // (null here) rather than being skipped outright — closing the row is a
    // different concern this function deliberately doesn't own.
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].blockedReason, null);
  });
});
