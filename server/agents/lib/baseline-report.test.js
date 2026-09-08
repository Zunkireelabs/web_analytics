import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Same db.js query-mocking convention as agent-memory.test.js (no existing
// DB-mocking convention beyond that for this repo's generator/store tests)
// — a fake in-memory implementation of just the SQL shapes
// baseline-report.js's real dependencies (store/read.js, store/recommendations.js,
// store/audit-runs.js, store/baseline-reports.js) actually issue, so what's
// under test is the real aggregation/honesty logic, not a hand-rolled
// substitute for it. callLLM is mocked directly (not via db.js) since it's a
// network call, not a query.

let savedRows;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, ' ').trim();

  if (sql.startsWith('SELECT * FROM sites WHERE id')) {
    return { rows: params[0] === 999 ? [] : [{ id: params[0], name: 'Test Site' }] };
  }
  if (sql.includes('FROM generate_series')) {
    return { rows: [] }; // no GSC/GA4 history yet — the sparse-data case under test
  }
  if (sql.includes('FROM daily_reports')) {
    return { rows: [] }; // no health-score snapshot yet
  }
  if (sql.startsWith("SELECT * FROM recommendations WHERE site_id")) {
    return { rows: [{ id: 1, page: '/pricing', recommendation_type: 'missing-schema', issue: 'No FAQPage schema', priority: 'high' }] };
  }
  if (sql.startsWith('SELECT * FROM audit_runs')) {
    return { rows: [] }; // full site audit still running — not available yet
  }
  if (sql.startsWith('INSERT INTO baseline_reports')) {
    savedRows = { site_id: params[0], kpi_snapshot: JSON.parse(params[1]), issues_snapshot: JSON.parse(params[2]), narrative_md: params[3], generated_at: new Date().toISOString() };
    return { rows: [savedRows] };
  }
  throw new Error(`fakeQuery: unhandled SQL: ${sql}`);
}

mock.module('../../db.js', { namedExports: { query: (...args) => fakeQuery(...args) } });
mock.module('../../llm.js', { namedExports: { callLLM: async () => '# Baseline Report — Test Site\n\n## Where Your Website Stood\nNo real history yet.\n\n## Issues We Found\n- One high-priority issue on /pricing.\n\n## What Happens Next\nFuture reports compare against this.' } });

const { buildBaselineReport } = await import('./baseline-report.js');

describe('buildBaselineReport', () => {
  beforeEach(() => { savedRows = null; });

  test('honestly reflects sparse KPI history and an unfinished audit, never fabricating a trend', async () => {
    const report = await buildBaselineReport(1);
    assert.equal(report.kpi_snapshot.daysOfHistory, 0);
    assert.equal(report.issues_snapshot.fullSiteAudit.available, false);
    assert.equal(report.issues_snapshot.openRecommendations.total, 1);
    assert.equal(report.issues_snapshot.openRecommendations.byPriority.high, 1);
  });

  test('persists a real narrative built from the given facts', async () => {
    const report = await buildBaselineReport(1);
    assert.match(report.narrative_md, /Baseline Report/);
    assert.equal(savedRows.site_id, 1);
  });

  test('returns null for a site that does not exist', async () => {
    const report = await buildBaselineReport(999);
    assert.equal(report, null);
  });
});
