import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

// Three agents that detected real, confirmed defects and surfaced none of
// them: every finding had a null recommendedAction and no reportOnly, which
// is the exact shape buildRecommendations discards. Each now declares
// whether its finding is a defect a human must own (reportOnly), context to
// read (still nothing), or — query-intelligence's cannibalization case,
// since 2026-09-12 — a real evidence-based fix once the data itself answers
// the question that used to be a human blocker.

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
    // device-ctr-diagnosis.js's own dependencies — the mobile deficit test
    // below is fully explained by its position gap, so diagnosis never
    // reaches the page-level checks these back, but they still need to
    // exist for device-intelligence.js's import chain to resolve.
    getPagePerformanceByDevice: async () => [],
    getQueriesForPage: async () => [],
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
  // Updated 2026-09-12: "which page should own a query" used to be treated
  // as an unanswerable human question (reportOnly, recommendedAction: null)
  // even though the agent already has the real GSC evidence — clicks,
  // impressions, position — that answers it. pickCannibalizationWinner now
  // makes that decision from that same evidence, and the losing page gets a
  // real, draftable internal-links recommendation instead of a dead end.
  // See server/agents/lib/cannibalization-decision.test.js for the scoring
  // itself; this covers the wiring end-to-end.
  test('two of the site\'s own pages competing for one query becomes a real, draftable recommendation for the losing page', async () => {
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
    assert.equal(finding.reportOnly, null);
    // /a has real, dominant clicks/impressions/position — the decided owner.
    assert.equal(finding.evidence.winner, 'https://example.com/a');
    // The finding targets the LOSING page with a real action reinforcing the
    // winner — never the winner itself, and never left as a dead end.
    assert.equal(finding.recommendedAction.generatorId, 'internal-links');
    assert.equal(finding.recommendedAction.params.page, 'https://example.com/b');
    assert.equal(finding.recommendedAction.params.mustLinkTo, 'https://example.com/a');
  });
});
