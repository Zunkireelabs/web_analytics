import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let perfRowsByPage;
let queryRows; // [{query, page, impressions}]

mock.module(resolve('../../store/read.js'), {
  namedExports: {
    getSearchPerformanceForPages: async (siteId, start, end, pages) => (
      pages.filter((p) => perfRowsByPage.has(p)).map((p) => ({ dim_value: p, ...perfRowsByPage.get(p) }))
    ),
    getQueryPageMetrics: async () => queryRows,
  },
});

const { decideWinner, allPairsOverlapSubstantially, fetchQuerySets, isLikelyFunctionalQueryParam, textSimilarity } = await import('./duplicate-evidence.js');

beforeEach(() => {
  perfRowsByPage = new Map();
  queryRows = [];
});

describe('decideWinner', () => {
  test('HIGH: exactly one candidate has traffic, the rest none', async () => {
    const traffic = [
      { page: '/a', clicks: 10, impressions: 100 },
      { page: '/b', clicks: 0, impressions: 0 },
    ];
    const result = await decideWinner(traffic, { siteId: 1, start: 's', end: 'e' });
    assert.equal(result.confidence, 'high');
    assert.equal(result.winner.page, '/a');
  });

  test('LOW: no candidate has any traffic', async () => {
    const traffic = [{ page: '/a', clicks: 0, impressions: 0 }, { page: '/b', clicks: 0, impressions: 0 }];
    const result = await decideWinner(traffic, { siteId: 1, start: 's', end: 'e' });
    assert.equal(result.confidence, 'low');
    assert.equal(result.winner, null);
  });

  test('MEDIUM stays MEDIUM when two traffic-bearing pages share no real queries', async () => {
    const traffic = [{ page: '/a', clicks: 10, impressions: 100 }, { page: '/b', clicks: 3, impressions: 40 }];
    queryRows = [
      { query: 'alpha', page: '/a', impressions: 50 },
      { query: 'beta', page: '/b', impressions: 30 },
    ];
    const result = await decideWinner(traffic, { siteId: 1, start: 's', end: 'e' });
    assert.equal(result.confidence, 'medium');
    assert.equal(result.winner, null);
  });

  test('MEDIUM escalates to HIGH when query sets overlap substantially and one page has strictly more clicks', async () => {
    const traffic = [{ page: '/a', clicks: 10, impressions: 100 }, { page: '/b', clicks: 3, impressions: 40 }];
    queryRows = [
      { query: 'q1', page: '/a', impressions: 50 }, { query: 'q2', page: '/a', impressions: 40 }, { query: 'q3', page: '/a', impressions: 30 },
      { query: 'q1', page: '/b', impressions: 20 }, { query: 'q2', page: '/b', impressions: 10 }, { query: 'q3', page: '/b', impressions: 5 },
    ];
    const result = await decideWinner(traffic, { siteId: 1, start: 's', end: 'e' });
    assert.equal(result.confidence, 'high');
    assert.equal(result.winner.page, '/a');
    assert.equal(result.queryOverlap.overlapping, true);
  });

  test('never picks a winner from a tied margin even with full query overlap', async () => {
    const traffic = [{ page: '/a', clicks: 10, impressions: 100 }, { page: '/b', clicks: 10, impressions: 100 }];
    queryRows = ['q1', 'q2', 'q3'].flatMap((q) => [{ query: q, page: '/a', impressions: 10 }, { query: q, page: '/b', impressions: 10 }]);
    const result = await decideWinner(traffic, { siteId: 1, start: 's', end: 'e' });
    assert.equal(result.confidence, 'medium');
    assert.equal(result.winner, null);
  });

  describe('split-traffic escalation signals', () => {
    test('canonical agreement wins outright even without query overlap', async () => {
      const traffic = [{ page: '/a', clicks: 10, impressions: 100 }, { page: '/b', clicks: 8, impressions: 90 }];
      const result = await decideWinner(traffic, {
        siteId: 1, start: 's', end: 'e',
        signals: { canonicalByPage: new Map([['/b', '/a']]) },
      });
      assert.equal(result.confidence, 'high');
      assert.equal(result.winner.page, '/a');
      assert.equal(result.decision, 'consolidate');
      assert.equal(result.decisionReason, 'canonical-tag-agreement');
    });

    test('a functional (non-tracking) query parameter blocks consolidation and is decided leave-both, not punted', async () => {
      const traffic = [{ page: '/a?package=gold', clicks: 10, impressions: 100 }, { page: '/b', clicks: 8, impressions: 90 }];
      const result = await decideWinner(traffic, {
        siteId: 1, start: 's', end: 'e',
        signals: { functionalParamPages: new Set(['/a?package=gold']) },
      });
      assert.equal(result.winner, null);
      assert.equal(result.decision, 'leave-both-independent-intent');
      assert.equal(result.decisionReason, 'functional-query-parameter');
    });

    test('genuinely different page purposes are decided leave-both, never used to force a merge', async () => {
      const traffic = [{ page: '/a', clicks: 10, impressions: 100 }, { page: '/b', clicks: 8, impressions: 90 }];
      const result = await decideWinner(traffic, {
        siteId: 1, start: 's', end: 'e',
        signals: { pagePurposeByPage: new Map([['/a', 'blog'], ['/b', 'product']]) },
      });
      assert.equal(result.winner, null);
      assert.equal(result.decision, 'leave-both-independent-intent');
      assert.equal(result.decisionReason, 'different-page-purpose');
    });

    test('same page purpose across candidates never blocks a later signal from deciding', async () => {
      const traffic = [{ page: '/a', clicks: 10, impressions: 100 }, { page: '/b', clicks: 3, impressions: 30 }];
      const result = await decideWinner(traffic, {
        siteId: 1, start: 's', end: 'e',
        signals: { pagePurposeByPage: new Map([['/a', 'blog'], ['/b', 'blog']]), contentSimilarity: 0.9 },
      });
      assert.equal(result.decision, 'consolidate');
      assert.equal(result.winner.page, '/a');
    });

    test('high content similarity plus a real click margin consolidates even without query overlap', async () => {
      const traffic = [{ page: '/a', clicks: 10, impressions: 100 }, { page: '/b', clicks: 3, impressions: 30 }];
      const result = await decideWinner(traffic, { siteId: 1, start: 's', end: 'e', signals: { contentSimilarity: 0.85 } });
      assert.equal(result.confidence, 'high');
      assert.equal(result.winner.page, '/a');
      assert.equal(result.decision, 'consolidate');
      assert.equal(result.decisionReason, 'content-similarity-plus-click-margin');
    });

    test('high content similarity never picks a winner from a tied click margin without a real internal-link difference', async () => {
      const traffic = [{ page: '/a', clicks: 10, impressions: 100 }, { page: '/b', clicks: 10, impressions: 100 }];
      const result = await decideWinner(traffic, { siteId: 1, start: 's', end: 'e', signals: { contentSimilarity: 0.9 } });
      assert.equal(result.winner, null);
      assert.equal(result.confidence, 'medium');
    });

    test('a tied click margin with high content similarity breaks the tie using a real internal-link count difference', async () => {
      const traffic = [{ page: '/a', clicks: 10, impressions: 100 }, { page: '/b', clicks: 10, impressions: 100 }];
      const result = await decideWinner(traffic, {
        siteId: 1, start: 's', end: 'e',
        signals: { contentSimilarity: 0.9, internalLinkCountByPage: new Map([['/a', 12], ['/b', 2]]) },
      });
      assert.equal(result.winner.page, '/a');
      assert.equal(result.decision, 'consolidate');
      assert.equal(result.decisionReason, 'content-similarity-plus-internal-links');
    });

    test('with no additional signals available at all, split traffic still stays a human reportOnly decision', async () => {
      const traffic = [{ page: '/a', clicks: 10, impressions: 100 }, { page: '/b', clicks: 3, impressions: 30 }];
      const result = await decideWinner(traffic, { siteId: 1, start: 's', end: 'e' });
      assert.equal(result.winner, null);
      assert.equal(result.decision, null);
      assert.equal(result.confidence, 'medium');
    });
  });

  test('three-way group: overlap must hold for EVERY pair, not just the strongest one', async () => {
    const traffic = [
      { page: '/a', clicks: 10, impressions: 100 },
      { page: '/b', clicks: 5, impressions: 50 },
      { page: '/c', clicks: 3, impressions: 30 },
    ];
    // a<->b overlap fully; c shares nothing with either -> must NOT escalate
    queryRows = [
      { query: 'q1', page: '/a', impressions: 10 }, { query: 'q2', page: '/a', impressions: 10 }, { query: 'q3', page: '/a', impressions: 10 },
      { query: 'q1', page: '/b', impressions: 10 }, { query: 'q2', page: '/b', impressions: 10 }, { query: 'q3', page: '/b', impressions: 10 },
      { query: 'zzz', page: '/c', impressions: 10 },
    ];
    const result = await decideWinner(traffic, { siteId: 1, start: 's', end: 'e' });
    assert.equal(result.confidence, 'medium');
  });
});

describe('allPairsOverlapSubstantially', () => {
  test('false when either side has no query evidence at all', () => {
    const sets = new Map([['/a', new Set(['q1', 'q2', 'q3'])], ['/b', new Set()]]);
    assert.equal(allPairsOverlapSubstantially(sets, ['/a', '/b']), false);
  });

  test('false below the minimum shared-query count even at 100% ratio of a tiny set', () => {
    const sets = new Map([['/a', new Set(['q1'])], ['/b', new Set(['q1', 'q2', 'q3', 'q4', 'q5'])]]);
    assert.equal(allPairsOverlapSubstantially(sets, ['/a', '/b']), false);
  });
});

describe('isLikelyFunctionalQueryParam', () => {
  test('false for no query string', () => {
    assert.equal(isLikelyFunctionalQueryParam('https://example.com/a'), false);
  });

  test('false when every param is known tracking noise', () => {
    assert.equal(isLikelyFunctionalQueryParam('https://example.com/a?utm_source=x&utm_medium=y&gclid=z'), false);
  });

  test('true when any param falls outside the tracking allowlist', () => {
    assert.equal(isLikelyFunctionalQueryParam('https://example.com/a?package=gold'), true);
    assert.equal(isLikelyFunctionalQueryParam('https://example.com/a?utm_source=x&page=2'), true);
  });

  test('false for an unparseable (non-absolute) URL — fails safe rather than assuming functional', () => {
    assert.equal(isLikelyFunctionalQueryParam('/a?package=gold'), false);
  });
});

describe('textSimilarity', () => {
  test('1 for identical text', () => {
    assert.equal(textSimilarity('hello world', 'hello world'), 1);
  });

  test('0 when either side is empty', () => {
    assert.equal(textSimilarity('', 'hello'), 0);
    assert.equal(textSimilarity('hello', ''), 0);
  });

  test('partial overlap is between 0 and 1', () => {
    const sim = textSimilarity('the quick brown fox', 'the slow brown dog');
    assert.ok(sim > 0 && sim < 1);
  });
});

describe('fetchQuerySets', () => {
  test('groups query rows by page, ignoring rows for pages not requested', async () => {
    queryRows = [{ query: 'a', page: '/x' }, { query: 'b', page: '/x' }, { query: 'c', page: '/not-requested' }];
    const sets = await fetchQuerySets(1, ['/x'], 's', 'e');
    assert.deepEqual([...sets.get('/x')].sort(), ['a', 'b']);
    assert.equal(sets.has('/not-requested'), false);
  });
});
