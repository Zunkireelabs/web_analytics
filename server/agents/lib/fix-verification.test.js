import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let due;
let recorded;
let fetchResult;
let openRec;
let closedIds;
let watchlistReopened;

mock.module(resolve('../../store/fix-verifications.js'), {
  namedExports: {
    getDueVerifications: async () => due,
    recordVerificationOutcome: async (id, outcome, evidence) => { recorded.push({ id, outcome, evidence }); return null; },
  },
});
mock.module(resolve('../../store/watchlist.js'), {
  namedExports: {
    getWatchlistItemById: async (siteId, id) => ({ id, status: 'completed' }),
    setWatchlistStatus: async (siteId, id, status, note) => { watchlistReopened.push({ siteId, id, status, note }); },
  },
});
const realPageContent = await import(resolve('./page-content.js'));
mock.module(resolve('./page-content.js'), {
  namedExports: {
    ...realPageContent,
    analyzePageUrl: async () => ({ ok: true, analysis: {} }),
    recommendationsFor: () => [],
    contentGapsFor: () => [],
    fetchHtml: async () => fetchResult,
  },
});
const realAgentMemory = await import(resolve('../../agent-memory.js'));
mock.module(resolve('../../agent-memory.js'), {
  namedExports: { ...realAgentMemory, recordFixOutcome: async () => {} },
});
const realRecommendations = await import(resolve('../../store/recommendations.js'));
mock.module(resolve('../../store/recommendations.js'), {
  namedExports: {
    ...realRecommendations,
    findOpenRecommendation: async () => openRec,
    closeRecommendation: async (id) => { closedIds.push(id); },
  },
});

const { runDueVerifications } = await import(resolve('./fix-verification.js'));

function verificationRow(overrides = {}) {
  return {
    id: 1, site_id: 1, generator_id: 'analytics-install', page_url: 'https://x.com/',
    query: 'G-ABC123', finding_id: 'trust-compliance:analytics:missing', watchlist_item_id: null,
    memory_ref_id: null, source: 'trust-compliance',
    ...overrides,
  };
}

beforeEach(() => {
  due = [];
  recorded = [];
  fetchResult = { ok: true, html: '' };
  openRec = null;
  closedIds = [];
  watchlistReopened = [];
});

describe('runDueVerifications — analytics-install tracking-ID verification', () => {
  test('the tracking ID is live on the page: verified-fixed, and the originating recommendation is closed', async () => {
    due = [verificationRow()];
    fetchResult = { ok: true, html: '<html><script>gtag("config","G-ABC123")</script></html>' };
    openRec = { id: 42 };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'verified-fixed');
    assert.equal(recorded[0].outcome, 'verified-fixed');
    assert.deepEqual(closedIds, [42], 'the real recommendation row is closed, not a made-up id');
  });

  test('the tracking ID is NOT live on the page: still-present, and nothing is closed', async () => {
    due = [verificationRow()];
    fetchResult = { ok: true, html: '<html>no tracking here</html>' };
    openRec = { id: 42 };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'still-present');
    assert.deepEqual(closedIds, [], 'a merged PR with no live tracking ID must never close the recommendation');
  });

  test('an unreachable page verifies neither way and closes nothing', async () => {
    due = [verificationRow()];
    fetchResult = { ok: false, error: 'timeout' };
    openRec = { id: 42 };

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'unreachable');
    assert.deepEqual(closedIds, []);
  });

  test('verified-fixed but the recommendation was already closed some other way: no error, nothing double-closed', async () => {
    due = [verificationRow()];
    fetchResult = { ok: true, html: 'G-ABC123' };
    openRec = null; // findOpenRecommendation found nothing — already closed

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'verified-fixed');
    assert.deepEqual(closedIds, []);
  });

  test('a still-present outcome with a watchlist item reopens it', async () => {
    due = [verificationRow({ watchlist_item_id: 7 })];
    fetchResult = { ok: true, html: 'nothing tracked here' };

    await runDueVerifications();

    assert.equal(watchlistReopened.length, 1);
    assert.equal(watchlistReopened[0].id, 7);
    assert.equal(watchlistReopened[0].status, 'new');
  });

  test('non-analytics-install rows still take the ordinary tag-recheck path, unaffected', async () => {
    due = [{
      id: 2, site_id: 1, generator_id: 'meta-title', page_url: 'https://x.com/p',
      query: 'some query', finding_id: 'f1', watchlist_item_id: null, memory_ref_id: null, source: 'opportunity',
    }];

    const results = await runDueVerifications();

    assert.equal(results[0].outcome, 'verified-fixed', 'empty tagsNow means nothing is still flagged');
    assert.deepEqual(closedIds, [], 'the recommendations.js close path is analytics-install-only');
  });
});
