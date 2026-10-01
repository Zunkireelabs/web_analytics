import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

// Regression coverage for the 2026-10 "unproven claim" audit of the data-
// driven agents: windows ending at 'today' against a ~3-day GSC lag, GA4
// windows reaching before the property's data starts ("Nepal 31 -> 599",
// "mobile 24 -> 480"), absolute deltas read as shifts during a whole-site
// surge, an unweighted 2-row CTR mean called a 'confirmed defect', and a
// narrative of "page looks solid" over zero rows.

let gscRows;       // getSearchPerformanceRange by dimType
let ga4ByWindow;   // { recent: rows, prior: rows } per dimType
let dataStart;     // first date GA4 has rows for
let perfRows;
const RECENT_FROM = '2026-09-04';

const dates = (start, end) => {
  const out = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSearchPerformanceRange: async (_s, _a, _b, dim) => (dim === 'page' ? [] : (gscRows[dim] || perfRows || [])),
    getGa4BreakdownRange: async (_s, start, _e, dim, limit) => {
      const set = ga4ByWindow[dim];
      if (!set) return [];
      return start >= RECENT_FROM ? set.recent : set.prior;
    },
    getBreakdownDataDates: async (_s, _src, _dim, start, end) => dates(start, end).filter((d) => d >= dataStart),
    getSiteById: async () => ({ id: 1, name: 'Site', domain: 'example.com' }),
    getTopPagePerQuery: async () => [],
    getPagePerformanceByDevice: async () => [],
    getQueriesForPage: async () => [],
  },
});
mock.module(resolve('../llm.js'), { namedExports: { callLLM: async () => 'narrative' } });

const device = await import('./device-intelligence.js');
const country = await import('./country-intelligence.js');
const opportunity = await import('./opportunity.js');

const RANGE = { siteId: 1, start: RECENT_FROM, end: '2026-10-01' };

beforeEach(() => {
  gscRows = {};
  ga4ByWindow = {};
  dataStart = '2026-01-01';
  perfRows = null;
});

describe('device-intelligence', () => {
  test('GA4 data starting mid-prior-window: no usage-shift claim at all (was "mobile 24 to 480")', async () => {
    dataStart = '2026-08-31'; // site 8862: only a few days of the prior window
    ga4ByWindow.device = {
      recent: [{ dim_value: 'mobile', sessions: 480 }, { dim_value: 'desktop', sessions: 100 }],
      prior: [{ dim_value: 'mobile', sessions: 24 }, { dim_value: 'desktop', sessions: 10 }],
    };
    gscRows.device = [];
    const r = await device.run(RANGE);
    assert.equal(r.facts.usageShift.status, 'insufficient-data');
    assert.deepEqual(r.facts.growingDevices, []);
    assert.deepEqual(r.facts.decliningDevices, []);
    assert.equal(r.facts.findings.length, 0);
  });

  test('a whole-site surge with an unchanged device mix is not a device shift', async () => {
    ga4ByWindow.device = {
      recent: [{ dim_value: 'mobile', sessions: 6000 }, { dim_value: 'desktop', sessions: 4000 }],
      prior: [{ dim_value: 'mobile', sessions: 600 }, { dim_value: 'desktop', sessions: 400 }],
    };
    gscRows.device = [];
    const r = await device.run(RANGE);
    assert.equal(r.facts.usageShift.status, 'ok');
    assert.deepEqual(r.facts.growingDevices, []);
    assert.deepEqual(r.facts.decliningDevices, []);
  });

  test('site 8862 mobile CTR (z~1.3, confounded by position) is NOT called a defect', async () => {
    ga4ByWindow.device = { recent: [], prior: [] };
    gscRows.device = [
      { dim_value: 'MOBILE', clicks: 9, impressions: 2191, ctr: 0.0041, avg_position: 11.2 },
      { dim_value: 'DESKTOP', clicks: 14, impressions: 1978, ctr: 0.0071, avg_position: 28.9 },
    ];
    const r = await device.run(RANGE);
    assert.deepEqual(r.facts.lowCtrDevices, []);
    assert.equal(r.facts.findings.filter((f) => f.id.includes('low-ctr')).length, 0);
  });

  test('a significant deficit carries a confirmed verification naming the test', async () => {
    ga4ByWindow.device = { recent: [], prior: [] };
    gscRows.device = [
      { dim_value: 'MOBILE', clicks: 40, impressions: 10000, ctr: 0.004, avg_position: 9 },
      { dim_value: 'DESKTOP', clicks: 400, impressions: 10000, ctr: 0.04, avg_position: 8 },
    ];
    const r = await device.run(RANGE);
    const f = r.facts.findings.find((x) => x.id.includes('low-ctr'));
    assert.equal(f.verification.verdict, 'confirmed');
    assert.equal(f.verification.method, 'two-proportion-z-test');
  });
});

describe('country-intelligence', () => {
  test('GA4 starting at the end of the prior window: no "grew from 31 to 599" market claim or landing-page finding', async () => {
    dataStart = '2026-09-10'; // site 8864
    ga4ByWindow.country = { recent: [{ dim_value: 'Nepal', sessions: 599 }], prior: [{ dim_value: 'Nepal', sessions: 31 }] };
    ga4ByWindow.city = { recent: [], prior: [] };
    ga4ByWindow.language = { recent: [], prior: [] };
    const r = await country.run(RANGE);
    assert.equal(r.facts.marketComparison.status, 'insufficient-data');
    assert.deepEqual(r.facts.growingMarkets, []);
    assert.equal(r.facts.findings.filter((f) => f.recommendedAction?.generatorId === 'landing-page').length, 0);
  });

  test('(not set) never becomes a growing market; ranking is by share change, not absolute delta, during a surge', async () => {
    ga4ByWindow.country = {
      prior: [{ dim_value: 'Nepal', sessions: 500 }, { dim_value: 'India', sessions: 100 }, { dim_value: '(not set)', sessions: 50 }],
      recent: [{ dim_value: 'Nepal', sessions: 5000 }, { dim_value: 'India', sessions: 2000 }, { dim_value: '(not set)', sessions: 900 }],
    };
    ga4ByWindow.city = { recent: [], prior: [] };
    ga4ByWindow.language = { recent: [], prior: [] };
    const r = await country.run(RANGE);
    const names = r.facts.growingMarkets.map((m) => m.country);
    assert.ok(!names.includes('(not set)'));
    // Nepal's absolute delta (4500) dwarfs India's (1900), but its share fell
    // (83% -> 71%); India's rose (17% -> 29%), so India is the gainer.
    assert.deepEqual(names, ['India']);
    assert.equal(r.facts.recommendations[0].params.market, 'India');
  });
});

describe('country-intelligence topGainerAboveThreshold', () => {
  test('skips (not set)/(other) and prefers the biggest share gainer', () => {
    const g = [
      { country: '(not set)', prior: 5, recent: 500, delta: 495, shareDeltaPp: 30 },
      { country: 'Germany', prior: 20, recent: 40, delta: 20, shareDeltaPp: 3 },
      { country: 'France', prior: 10, recent: 30, delta: 20, shareDeltaPp: 6 },
    ];
    assert.equal(country.topGainerAboveThreshold(g).country, 'France');
  });
  test('a gainer whose share did not rise is not recommended', () => {
    assert.equal(country.topGainerAboveThreshold([{ country: 'Germany', prior: 20, recent: 40, delta: 20, shareDeltaPp: -1 }]), null);
  });
});

describe('opportunity', () => {
  const run = (extra = {}) => opportunity.run({ siteId: 1, start: '2026-09-04', end: '2026-10-01', pageCache: async () => ({ ok: false, error: 'x' }), ...extra });

  test('zero rows -> insufficient-data, no narrative ("page looks solid" over nothing)', async () => {
    perfRows = [];
    const r = await run();
    assert.equal(r.status, 'insufficient-data');
    assert.equal(r.narrative, null);
    assert.equal(r.facts.count, 0);
  });

  test('rows with a trivial total impression count -> insufficient-data', async () => {
    perfRows = [{ dim_value: 'q', clicks: 0, impressions: 40, ctr: 0, avg_position: 8 }];
    assert.equal((await run()).status, 'insufficient-data');
  });

  test('data present but nothing in striking distance -> insufficient-data with an explanatory message', async () => {
    perfRows = [{ dim_value: 'q', clicks: 80, impressions: 500, ctr: 0.16, avg_position: 1.2 }];
    const r = await run();
    assert.equal(r.status, 'insufficient-data');
    assert.match(r.message, /striking|positions/i);
  });

  test('the impression floor was raised above 10', () => {
    assert.ok(opportunity.MIN_IMPRESSIONS > 10);
  });

  test('traffic gain is labeled an estimate on the row and in the assumptions', async () => {
    perfRows = [{ dim_value: 'q', clicks: 5, impressions: 400, ctr: 0.0125, avg_position: 9 }];
    const r = await run();
    assert.equal(r.status, 'ok');
    assert.equal(r.facts.opportunities[0].estimatedTrafficGainBasis, 'estimate');
    assert.equal(r.facts.assumptions.trafficGainBasis, 'estimate');
  });
});
