import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

// Three agents that detected real, confirmed defects and surfaced none of
// them: every finding had a null recommendedAction and no reportOnly, which
// is the exact shape buildRecommendations discards. Each now declares whether
// its finding is a defect a human must own (reportOnly) or context to read
// (still nothing) — the distinction, not blanket surfacing, is the fix.

let deviceRows;
let deltaRows;
let cannibalized;

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSearchPerformanceRange: async () => deviceRows,
    getGa4BreakdownDelta: async () => deltaRows,
    getGscBreakdownRange: async () => [],
    getTopMovers: async () => ({ gainers: [], droppers: [] }),
    getCannibalizedQueries: async () => cannibalized,
    getSiteById: async () => ({ id: 1, name: 'Example' }),
  },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});

const device = await import('./device-intelligence.js');
const queryIntel = await import('./query-intelligence.js');

const RANGE = { siteId: 1, start: '2026-08-01', end: '2026-08-28' };

describe('device-intelligence surfaces a real CTR deficit', () => {
  test('an under-performing device becomes a visible read-only row', async () => {
    // One device far below the site's own cross-device average — a real
    // deficit, not a trend.
    // Both rows clear the real-impressions floor flagLowCtr enforces, so the
    // gap is a property of the device rather than of a couple of stray clicks.
    deviceRows = [
      { dim_value: 'MOBILE', clicks: 10, impressions: 10000, ctr: 0.001, avg_position: 12 },
      { dim_value: 'DESKTOP', clicks: 900, impressions: 10000, ctr: 0.09, avg_position: 8 },
    ];
    deltaRows = { gainers: [], droppers: [] };

    const result = await device.run(RANGE);
    const lowCtr = (result.facts?.findings || []).find((f) => f.id.startsWith('device-intelligence:low-ctr:'));

    assert.ok(lowCtr, 'expected a low-CTR finding for the under-performing device');
    assert.equal(lowCtr.reportOnly.kind, 'device-ctr-deficit');
    // No file to change — the cause is spread across layout, speed and how
    // titles truncate on that device.
    assert.equal(lowCtr.recommendedAction, null);
  });

  test('a device merely losing sessions stays context, not a row', async () => {
    deviceRows = [
      { dim_value: 'MOBILE', clicks: 500, impressions: 10000, ctr: 0.05, avg_position: 9 },
      { dim_value: 'DESKTOP', clicks: 500, impressions: 10000, ctr: 0.05, avg_position: 9 },
    ];
    deltaRows = { gainers: [], droppers: [{ dim_value: 'tablet', recent: 10, prior: 50, delta: -40 }] };

    const result = await device.run(RANGE);
    const declining = (result.facts?.findings || []).find((f) => f.id.startsWith('device-intelligence:declining:'));

    assert.ok(declining, 'expected a declining-device finding');
    // Surfacing every trend line would bury the actionable list — this one is
    // a number a human reads in a report.
    assert.equal(declining.reportOnly, null);
  });
});

describe('query-intelligence surfaces cannibalization', () => {
  test('two of the site\'s own pages competing for one query becomes a visible row', async () => {
    cannibalized = [{
      query: 'wedding venues',
      pages: [
        { page: 'https://example.com/a', clicks: 40, impressions: 900, avg_position: 8 },
        { page: 'https://example.com/b', clicks: 20, impressions: 800, avg_position: 12 },
      ],
    }];

    const result = await queryIntel.run(RANGE);
    const finding = (result.facts?.findings || []).find((f) => f.id.startsWith('query-intelligence:cannibalization:'));

    assert.ok(finding, 'expected a cannibalization finding');
    assert.equal(finding.reportOnly.kind, 'query-cannibalization');
    // Anchored to a real member page so the row's (page, kind) dedup key is
    // stable across runs.
    assert.equal(finding.reportOnly.page, 'https://example.com/a');
    // Which page should own a query depends on what the business wants it to
    // sell — no signal here carries that.
    assert.equal(finding.recommendedAction, null);
  });
});
