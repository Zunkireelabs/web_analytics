import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const { makeQueryLookup } = await import(resolve('./recommendations.js'));

describe('makeQueryLookup — curiosity/investigation before giving up', () => {
  test('returns the query found in the agent\'s own run window without widening', async () => {
    let dataRangeCalls = 0;
    const lookup = makeQueryLookup(1, {
      getQueriesForPageFn: async (siteId, start, end, page) => {
        assert.equal(start, '2026-09-01');
        assert.equal(end, '2026-09-07');
        return [{ query: 'real query in window', clicks: 5 }];
      },
      getDataRangeFn: async () => { dataRangeCalls++; return { earliest: '2026-01-01', freshest: '2026-09-20' }; },
    });

    const q = await lookup('2026-09-01', '2026-09-07', '/a');
    assert.equal(q, 'real query in window');
    assert.equal(dataRangeCalls, 0, 'never widens when the narrow window already found something');
  });

  test('widens to the page\'s full GSC history when the narrow window found nothing', async () => {
    const calls = [];
    const lookup = makeQueryLookup(1, {
      getQueriesForPageFn: async (siteId, start, end, page) => {
        calls.push({ start, end });
        if (start === '2026-01-01' && end === '2026-09-20') return [{ query: 'found in wider history', clicks: 2 }];
        return [];
      },
      getDataRangeFn: async () => ({ earliest: '2026-01-01', freshest: '2026-09-20' }),
    });

    const q = await lookup('2026-09-01', '2026-09-07', '/a');
    assert.equal(q, 'found in wider history');
    assert.deepEqual(calls, [
      { start: '2026-09-01', end: '2026-09-07' },
      { start: '2026-01-01', end: '2026-09-20' },
    ], 'tries the narrow window first, only widens after it comes back empty');
  });

  test('genuinely no traffic anywhere still returns empty — investigation exhausted, not fabricated', async () => {
    const lookup = makeQueryLookup(1, {
      getQueriesForPageFn: async () => [],
      getDataRangeFn: async () => ({ earliest: '2026-01-01', freshest: '2026-09-20' }),
    });

    const q = await lookup('2026-09-01', '2026-09-07', '/a');
    assert.equal(q, '');
  });

  test('site with no GSC data at all (null range) never issues a second, meaningless query', async () => {
    let queryCalls = 0;
    const lookup = makeQueryLookup(1, {
      getQueriesForPageFn: async () => { queryCalls++; return []; },
      getDataRangeFn: async () => ({ earliest: null, freshest: null }),
    });

    const q = await lookup('2026-09-01', '2026-09-07', '/a');
    assert.equal(q, '');
    assert.equal(queryCalls, 1);
  });

  test('the narrow window already equals the full available range — skips a redundant identical re-query', async () => {
    let queryCalls = 0;
    const lookup = makeQueryLookup(1, {
      getQueriesForPageFn: async () => { queryCalls++; return []; },
      getDataRangeFn: async () => ({ earliest: '2026-09-01', freshest: '2026-09-07' }),
    });

    await lookup('2026-09-01', '2026-09-07', '/a');
    assert.equal(queryCalls, 1, 'the agent\'s own window already IS the full history — a second identical query would find nothing new');
  });

  test('getDataRange is fetched at most once per lookup instance, even across multiple ungrounded pages', async () => {
    let dataRangeCalls = 0;
    const lookup = makeQueryLookup(1, {
      getQueriesForPageFn: async () => [],
      getDataRangeFn: async () => { dataRangeCalls++; return { earliest: '2026-01-01', freshest: '2026-09-20' }; },
    });

    await lookup('2026-09-01', '2026-09-07', '/a');
    await lookup('2026-09-01', '2026-09-07', '/b');
    assert.equal(dataRangeCalls, 1, 'site-wide bounds are fetched once, not once per page');
  });

  test('caches by the originally requested window/page, not the widened one', async () => {
    let queryCalls = 0;
    const lookup = makeQueryLookup(1, {
      getQueriesForPageFn: async () => { queryCalls++; return [{ query: 'x', clicks: 1 }]; },
      getDataRangeFn: async () => ({ earliest: '2026-01-01', freshest: '2026-09-20' }),
    });

    await lookup('2026-09-01', '2026-09-07', '/a');
    await lookup('2026-09-01', '2026-09-07', '/a');
    assert.equal(queryCalls, 1, 'second call for the same start/end/page hits the cache');
  });
});
