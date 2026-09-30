import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// getRecentPageInsights' root-cause LEFT JOIN (2026-09 Data Analyst audit
// finding #2) — the Python Root Cause Analysis Engine's own output
// (root_cause_analysis_runs/nodes) was computed but never read on the Node
// side. Proves the join result maps to topRootCause correctly, and stays
// honestly null when there's nothing to report — never fabricated.

let rows;
let issued;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();
  issued.push({ sql, params });
  if (sql.startsWith('SELECT i.id')) return { rows };
  throw new Error(`data-analyst-root-cause.test.js fake query: unhandled SQL shape: ${sql}`);
}

const resolve = (p) => new URL(p, import.meta.url).href;
mock.module(resolve('../db.js'), { namedExports: { query: (text, params) => fakeQuery(text, params) } });
const { getRecentPageInsights } = await import('./data-analyst.js');

beforeEach(() => { issued = []; rows = []; });

describe('getRecentPageInsights — root-cause join', () => {
  test('the query joins root_cause_analysis_runs/nodes and scopes by client_id + dimension_type', async () => {
    rows = [];
    await getRecentPageInsights(1);
    assert.match(issued[0].sql, /root_cause_analysis_runs/);
    assert.match(issued[0].sql, /root_cause_analysis_nodes/);
    assert.match(issued[0].sql, /r\.status = 'ok'/);
    assert.deepEqual(issued[0].params, [1, 21]);
  });

  test('a row with a real root-cause match maps to a topRootCause object', async () => {
    rows = [{
      id: 1, metric_key: 'gsc_clicks', page: '/p', insight_type: 'anomaly', severity: 'high', evidence: {}, generated_at: '2026-09-01', period_start: '2026-08-25',
      root_cause_dimension_type: 'device', root_cause_dimension_value: 'mobile', root_cause_share_pct: '62.4',
    }];
    const result = await getRecentPageInsights(1);
    assert.deepEqual(result[0].topRootCause, { dimensionType: 'device', dimensionValue: 'mobile', sharePct: 62.4 });
  });

  test('a row with no root-cause match (LEFT JOIN found nothing) reports topRootCause: null, never fabricated', async () => {
    rows = [{
      id: 2, metric_key: 'gsc_clicks', page: '/p', insight_type: 'forecast_risk', severity: 'medium', evidence: {}, generated_at: '2026-09-01', period_start: '2026-08-25',
      root_cause_dimension_type: null, root_cause_dimension_value: null, root_cause_share_pct: null,
    }];
    const result = await getRecentPageInsights(1);
    assert.equal(result[0].topRootCause, null);
  });

  test('sharePct is coerced to a real number, not left as a Postgres numeric string', async () => {
    rows = [{
      id: 3, page: '/p', insight_type: 'anomaly', evidence: {},
      root_cause_dimension_type: 'country', root_cause_dimension_value: 'IN', root_cause_share_pct: '40.00',
    }];
    const result = await getRecentPageInsights(1);
    assert.equal(typeof result[0].topRootCause.sharePct, 'number');
    assert.equal(result[0].topRootCause.sharePct, 40);
  });

  test('every original insight field survives the join unchanged', async () => {
    rows = [{ id: 4, metric_key: 'gsc_impressions', page: '/x', insight_type: 'trend_shift', severity: 'low', evidence: { pct_change: -12 }, generated_at: '2026-09-02', period_start: '2026-08-20', root_cause_dimension_type: null, root_cause_dimension_value: null, root_cause_share_pct: null }];
    const result = await getRecentPageInsights(1);
    assert.equal(result[0].id, 4);
    assert.equal(result[0].page, '/x');
    assert.deepEqual(result[0].evidence, { pct_change: -12 });
  });
});
