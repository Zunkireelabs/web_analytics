import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let volumeRows;
let volumeCalls;
let volumeError;

mock.module(resolve('../../ingest/dataforseo-keywords.js'), {
  namedExports: {
    configured: () => true,
    fetchSearchVolume: async (keywords, opts) => {
      volumeCalls.push({ keywords, opts });
      if (volumeError) throw volumeError;
      return volumeRows;
    },
  },
});

const { dataForSeoSearchDemandProvider: provider, trendFromMonthly, clearDemandCache, PROVIDER_ID } =
  await import('./dataforseo.js');
const { getSearchDemandProvider } = await import('./registry.js');

const months = (volumes) => volumes.map((searchVolume, i) => ({ year: 2026, month: 12 - i, searchVolume }));

beforeEach(() => {
  volumeRows = [];
  volumeCalls = [];
  volumeError = null;
  clearDemandCache();
  process.env.SEARCH_DEMAND_PROVIDER = PROVIDER_ID;
});

describe('activation', () => {
  test('credentials alone are not enough — every call is billed, so it must be named', () => {
    // A deploy with DataForSEO keys for the SERP and backlinks adapters
    // must not silently start paying for demand lookups on cron.
    delete process.env.SEARCH_DEMAND_PROVIDER;
    assert.equal(provider.configured(), false);
    assert.equal(getSearchDemandProvider().id, 'null');
  });

  test('named plus credentials activates it, and the registry returns it', () => {
    process.env.SEARCH_DEMAND_PROVIDER = PROVIDER_ID;
    assert.equal(provider.configured(), true);
    assert.equal(getSearchDemandProvider().id, PROVIDER_ID);
  });
});

describe('trendFromMonthly', () => {
  test('too short a series yields no trend at all, never "stable"', () => {
    // "stable" is a claim. Claiming it from two data points is the
    // confident-wrong number this provider layer exists to avoid.
    assert.deepEqual(trendFromMonthly(months([100, 100])), { volumeTrend: null, volumeTrendPct: null });
    assert.deepEqual(trendFromMonthly(null), { volumeTrend: null, volumeTrendPct: null });
  });

  test('a recent quarter well above the prior one is rising', () => {
    const out = trendFromMonthly(months([200, 200, 200, 100, 100, 100]));
    assert.equal(out.volumeTrend, 'rising');
    assert.equal(out.volumeTrendPct, 100);
  });

  test('a recent quarter well below the prior one is falling', () => {
    assert.equal(trendFromMonthly(months([50, 50, 50, 100, 100, 100])).volumeTrend, 'falling');
  });

  test('a move inside the seasonality band is stable', () => {
    assert.equal(trendFromMonthly(months([105, 105, 105, 100, 100, 100])).volumeTrend, 'stable');
  });

  test('a prior quarter of zero yields no trend rather than an infinite percentage', () => {
    assert.deepEqual(trendFromMonthly(months([100, 100, 100, 0, 0, 0])), { volumeTrend: null, volumeTrendPct: null });
  });
});

describe('fetchDemandBulk', () => {
  test('one request serves the whole batch, with the exact topics as keywords', async () => {
    volumeRows = [
      { keyword: 'student visa nepal', searchVolume: 1200, monthlySearches: months([400, 400, 400, 200, 200, 200]) },
      { keyword: 'study abroad costs', searchVolume: 800, monthlySearches: [] },
    ];

    const out = await provider.fetchDemandBulk(['student visa nepal', 'study abroad costs']);

    assert.equal(volumeCalls.length, 1);
    assert.deepEqual(volumeCalls[0].keywords, ['student visa nepal', 'study abroad costs']);
    assert.equal(out.get('student visa nepal').searchVolume, 1200);
    assert.equal(out.get('student visa nepal').volumeTrend, 'rising');
    assert.equal(out.get('student visa nepal').asOf, '2026-12-01');
    // No series, so no trend — the volume is still real.
    assert.equal(out.get('study abroad costs').available, true);
    assert.equal(out.get('study abroad costs').volumeTrend, null);
  });

  test('a topic the endpoint omits is reported unavailable, never as zero demand', async () => {
    // DataForSEO omits keywords with no measurable volume. A zero would be
    // indistinguishable to a caller from "we never asked".
    volumeRows = [];
    const out = await provider.fetchDemandBulk(['some extremely obscure phrase']);
    const signal = out.get('some extremely obscure phrase');

    assert.equal(signal.available, false);
    assert.equal(signal.searchVolume, null);
    assert.match(signal.note, /no measurable search volume/);
  });

  test('a failed lookup marks the whole chunk unavailable with the reason, not zero', async () => {
    volumeError = new Error('HTTP 402');
    const out = await provider.fetchDemandBulk(['a', 'b']);

    for (const topic of ['a', 'b']) {
      assert.equal(out.get(topic).available, false);
      assert.match(out.get(topic).note, /HTTP 402/);
    }
  });

  test('matching is case- and whitespace-insensitive, because the caller supplies topic titles', async () => {
    volumeRows = [{ keyword: 'student visa nepal', searchVolume: 1200, monthlySearches: [] }];
    const out = await provider.fetchDemandBulk(['  Student Visa Nepal ']);
    assert.equal(out.get('  Student Visa Nepal ').searchVolume, 1200);
  });

  test('a second lookup of the same topic is served from cache and costs nothing', async () => {
    volumeRows = [{ keyword: 'a', searchVolume: 10, monthlySearches: [] }];
    await provider.fetchDemandBulk(['a']);
    await provider.fetchDemandBulk(['a']);
    assert.equal(volumeCalls.length, 1);
  });

  test('a no-volume answer is cached too, so an obscure topic is not re-billed every run', async () => {
    volumeRows = [];
    await provider.fetchDemandBulk(['obscure']);
    await provider.fetchDemandBulk(['obscure']);
    assert.equal(volumeCalls.length, 1);
  });

  test('a failed lookup is NOT cached, so a transient outage does not poison the whole TTL', async () => {
    volumeError = new Error('timeout');
    await provider.fetchDemandBulk(['a']);
    volumeError = null;
    volumeRows = [{ keyword: 'a', searchVolume: 99, monthlySearches: [] }];

    const out = await provider.fetchDemandBulk(['a']);
    assert.equal(out.get('a').searchVolume, 99);
    assert.equal(volumeCalls.length, 2);
  });

  test('a batch larger than one request is chunked rather than truncated', async () => {
    const topics = Array.from({ length: 45 }, (_, i) => `topic ${i}`);
    volumeRows = [];
    await provider.fetchDemandBulk(topics);

    assert.equal(volumeCalls.length, 3);
    assert.equal(volumeCalls.reduce((n, c) => n + c.keywords.length, 0), 45);
  });

  test('an empty or blank-only batch costs nothing', async () => {
    assert.equal((await provider.fetchDemandBulk([])).size, 0);
    assert.equal((await provider.fetchDemandBulk(['  ', null])).size, 0);
    assert.equal(volumeCalls.length, 0);
  });
});

describe('fetchDemand', () => {
  test('delegates to the batch path so there is one implementation', async () => {
    volumeRows = [{ keyword: 'x', searchVolume: 5, monthlySearches: [] }];
    const signal = await provider.fetchDemand('x');
    assert.equal(signal.searchVolume, 5);
    assert.equal(signal.providerId, PROVIDER_ID);
  });
});
