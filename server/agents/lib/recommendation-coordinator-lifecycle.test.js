import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// syncFromGrounded's own module transitively imports ../runner.js, which
// loads the whole agent registry and, through llm.js -> openai, a
// transitive dependency (formdata-node/web-streams-polyfill) that fails to
// instantiate under node:test's module mocking — the same issue
// analyst-sync.test.js documents. Every collaborator is mocked narrowly so
// that chain is never actually reached.
let inserted, merged, refreshed, closedStaleArgs, markedUnfixable, openRecommendation;

mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    findOpenRecommendation: async () => openRecommendation,
    insertRecommendation: async (siteId, rec) => { inserted.push(rec); return { id: inserted.length }; },
    mergeIntoRecommendation: async (id, patch) => { merged.push({ id, ...patch }); },
    refreshRecommendationBlockState: async (id, patch) => { refreshed.push({ id, ...patch }); },
    listOpenBlockedRecommendations: async () => [],
    closeStaleRecommendations: async (siteId, keys, checked) => { closedStaleArgs = { siteId, keys, checked }; return 0; },
    markRecommendationsUnfixable: async (siteId, dropped) => { markedUnfixable = { siteId, dropped }; return dropped.length; },
    listOpenRecommendations: async () => [],
    getRecommendationById: async () => null,
    closeRecommendation: async () => {},
  },
});
mock.module(resolve('../../store/drafts.js'), { namedExports: {
  getDraftedFindingIds: async () => new Set(),
  // getRecommendations now derives each card's lifecycle from its live
  // draft rather than only asking whether one exists, so the mock has to
  // supply this too. Empty map = no drafts, which is what these tests mean.
  getLiveDraftsByFindingId: async () => new Map(),
} });
mock.module(resolve('../../store/recommendation-attempts.js'), { namedExports: {
  attemptSummaryByFinding: async () => new Map(),
} });
mock.module(resolve('./command-center.js'), { namedExports: { categoryByAgentId: async () => new Map() } });
mock.module(resolve('../runner.js'), { namedExports: { runAgent: async () => { throw new Error('must not be reached by syncFromGrounded'); } } });
mock.module(resolve('./recommendation-gates.js'), { namedExports: { createRecommendationGates: () => { throw new Error('must not be reached by syncFromGrounded'); } } });

const { syncFromGrounded } = await import('./recommendation-coordinator.js');

beforeEach(() => {
  inserted = []; merged = []; refreshed = []; closedStaleArgs = null; markedUnfixable = null; openRecommendation = null;
});

// The immortal-row bug this closes: a page buildRecommendations proved
// unfixable this run (soft-404, a mapped file confirmed gone) was previously
// just absent from detectedKeys, leaving it to closeStaleRecommendations'
// rotation-gated sweep — which never re-selects a page that no longer
// exists, so it never closed. droppedRecommendations is direct evidence
// gathered THIS run, and must be acted on immediately.
describe('syncFromGrounded — droppedRecommendations reach markRecommendationsUnfixable', () => {
  test('a dropped recommendation is marked unfixable, independent of closeStaleRecommendations', async () => {
    await syncFromGrounded(7, {
      items: [],
      detectedKeys: new Set(),
      droppedRecommendations: [{ generatorId: 'alt-text', page: 'https://x.com/docs/gone/', reason: 'soft-404' }],
    });

    assert.ok(markedUnfixable, 'markRecommendationsUnfixable must be called');
    assert.equal(markedUnfixable.siteId, 7);
    assert.deepEqual(markedUnfixable.dropped, [{ generatorId: 'alt-text', page: 'https://x.com/docs/gone/', reason: 'soft-404' }]);
    assert.ok(closedStaleArgs, 'the ordinary stale sweep still runs alongside it');
  });

  test('no dropped recommendations this run — markRecommendationsUnfixable is never called', async () => {
    await syncFromGrounded(7, { items: [], detectedKeys: new Set(), droppedRecommendations: [] });
    assert.equal(markedUnfixable, null, 'an empty list must not issue a pointless query');
  });

  test('grounded output with no droppedRecommendations key at all (older shape) does not throw', async () => {
    await syncFromGrounded(7, { items: [], detectedKeys: new Set() });
    assert.equal(markedUnfixable, null);
  });
});
