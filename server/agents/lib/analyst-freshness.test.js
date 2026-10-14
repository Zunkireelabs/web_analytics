import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// data-freshness.js is mocked at module scope, before analyst-freshness.js
// (or anything importing it) ever loads — mock.module cannot retroactively
// intercept a module that already loaded via a static import, which is
// exactly what a top-level `import { gate } from './analyst-freshness.js'`
// would have done here. `scenario` is mutated per test to drive each
// fixture; every describe block below shares this one registration.
let scenario;
const freshRow = () => ({ as_of: '2026-09-08', rows_total: 500 });
mock.module(resolve('../../store/data-freshness.js'), {
  namedExports: {
    gscPageDataAsOf: async () => scenario?.gscPage ?? freshRow(),
    gscQueryPageDataAsOf: async () => scenario?.gscQueryPage ?? freshRow(),
    metricObservationsAsOf: async () => scenario?.metricObservations ?? freshRow(),
    pageQueryObservationsAsOf: async () => scenario?.pageQueryObservations ?? freshRow(),
    forecastRunsAsOf: async () => scenario?.forecastRuns ?? freshRow(),
    anomaliesAsOf: async () => scenario?.anomalies ?? freshRow(),
    latestCollectorRuns: async () => scenario?.collectorRuns ?? [],
  },
});
const { gate, checkAnalystFreshness } = await import(resolve('./analyst-freshness.js'));

// gate() is pure and takes the shape checkAnalystFreshness returns — tested
// directly here rather than through the DB reads, which need a live
// Postgres (see checkAnalystFreshness's own store, data-freshness.js).

describe('gate', () => {
  test('fresh inputs: autonomous action allowed, presented as current', () => {
    const g = gate({ verdict: 'fresh', failingCollectors: [] });
    assert.equal(g.allowAutonomous, true);
    assert.equal(g.presentation, 'current');
  });

  test('degraded inputs: still allowed, but flagged degraded', () => {
    const g = gate({ verdict: 'degraded', failingCollectors: [] });
    assert.equal(g.allowAutonomous, true);
    assert.equal(g.presentation, 'degraded');
  });

  test('stale inputs: autonomous action is REFUSED — the twelve-day outage scenario', () => {
    const g = gate({
      verdict: 'stale',
      failingCollectors: [{ collectorId: 'gsc_page_dimension', status: 'error', error: 'ConnectError (no message)' }],
    });
    assert.equal(g.allowAutonomous, false);
    assert.equal(g.presentation, 'stale-do-not-trust');
    assert.match(g.reason, /gsc_page_dimension/);
  });

  test('stale with no named collector still refuses, with a generic reason', () => {
    const g = gate({ verdict: 'stale', failingCollectors: [] });
    assert.equal(g.allowAutonomous, false);
    assert.match(g.reason, /stale/);
  });
});

// checkAnalystFreshness's own verdict must key off DATA recency in
// metric_observations/page_query_observations/gsc_query_page — never off
// whether the MOST RECENT ingestion_runs row happened to use MCP or the
// direct-database fallback (data-analyst-agent/app/mcp_client/datasource.py).
// MCP being unreachable one night must not, by itself, veto autonomous
// action the next morning when the fallback kept those tables current —
// that would recreate a milder version of the exact twelve-day-outage
// failure mode this module exists to catch, just triggered by a healthy
// fallback instead of a real gap.
describe('checkAnalystFreshness — data-driven, not transport-driven', () => {
  const NOW = new Date('2026-09-09T06:00:00Z');
  const yesterday = '2026-09-08';

  test('a collector that failed via MCP outage, with the fallback keeping data fresh, still reads as fresh', async () => {
    // The MCP call itself failed last night (401 — token revoked, the same
    // shape run_nightly.py's DataSource catches and falls back from) — but
    // because the fallback still wrote fresh observations, that run's own
    // status is 'ok' with source 'direct-db', exactly what run_nightly.py
    // now records. It must NOT appear as a failing collector: the collector
    // did not fail, MCP did, and the run recovered.
    scenario = { collectorRuns: [{ collector_id: 'gsc_daily', status: 'ok', error: null, created_at: yesterday }] };

    const freshness = await checkAnalystFreshness(1, { now: NOW });

    assert.equal(freshness.verdict, 'fresh', 'a healthy fallback must read as fresh, not stale');
    assert.equal(freshness.confidenceMultiplier, 1);
    assert.deepEqual(freshness.failingCollectors, []);
    assert.equal(gate(freshness).allowAutonomous, true);
  });

  test('a collector still genuinely failing (status error) IS named, even though the tables happen to still be within threshold', async () => {
    scenario = {
      collectorRuns: [{ collector_id: 'monthly_metrics', status: 'error', error: 'McpToolError: bad range', created_at: yesterday }],
    };

    const freshness = await checkAnalystFreshness(1, { now: NOW });

    // Core tables are fresh, so the verdict itself stays 'fresh' — but the
    // failing collector is still surfaced for visibility, proving the two
    // signals are independent rather than one silently overriding the other.
    assert.equal(freshness.verdict, 'fresh');
    assert.equal(freshness.failingCollectors.length, 1);
    assert.equal(freshness.failingCollectors[0].collectorId, 'monthly_metrics');
  });

  test('a genuine data gap (both sources stale) still refuses autonomous action, fallback or not', async () => {
    const staleRow = { as_of: '2026-08-01', rows_total: 10 };
    scenario = {
      gscQueryPage: staleRow, metricObservations: staleRow, pageQueryObservations: staleRow,
      collectorRuns: [{ collector_id: 'gsc_daily', status: 'error', error: 'ConnectError (no message)', created_at: staleRow.as_of }],
    };

    const freshness = await checkAnalystFreshness(1, { now: NOW });

    assert.equal(freshness.verdict, 'stale');
    assert.equal(gate(freshness).allowAutonomous, false, 'a real, unrecovered gap must still veto autonomous action');
  });
});
