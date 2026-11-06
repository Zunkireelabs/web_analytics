import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readPagesReport, summarizePages, PAGES_PER_DAY } from './ga4.js';

// The response shape below is the REAL google.analytics.data.v1beta RunReportResponse for
//   dimensions [pageTitle], metrics [screenPageViews, totalUsers]
// as @google-analytics/data returns it: metric and dimension values are { value: '<string>' }, numbers arrive as strings,
// and `metadata` is a ResponseMetaData (dataLossFromOtherRow, subjectToThresholding, emptyReason, samplingMetadatas).
// Field names were checked against build/protos/protos.d.ts, not assumed.
const row = (title, views, users) => ({ dimensionValues: [{ value: title }], metricValues: [{ value: String(views) }, { value: String(users) }] });
const response = (rows, metadata = {}) => ({
  dimensionHeaders: [{ name: 'pageTitle' }],
  metricHeaders: [{ name: 'screenPageViews', type: 'TYPE_INTEGER' }, { name: 'totalUsers', type: 'TYPE_INTEGER' }],
  rows, rowCount: rows.length, metadata: { currencyCode: 'USD', timeZone: 'Europe/London', ...metadata }, kind: 'analyticsData#runReport',
});

describe('readPagesReport', () => {
  test('reads titles, views and users from the real response shape, most viewed first', () => {
    const out = readPagesReport(response([row('Contact us', 233, 150), row('House Removals, Dorking', 412, 300)]), 700);
    assert.deepEqual(out.pages, [
      { page_title: 'House Removals, Dorking', views: 412, users: 300 },
      { page_title: 'Contact us', views: 233, users: 150 },
    ]);
  });

  test('numbers arriving as strings become numbers', () => {
    assert.equal(typeof readPagesReport(response([row('Home', 5, 2)]), 5).pages[0].views, 'number');
  });

  test('an empty or missing title becomes (not set), and two titles that collapse together are added, not dropped', () => {
    const out = readPagesReport(response([row('', 3, 1), row('(not set)', 4, 2), row('  Home  ', 1, 1), row('Home', 2, 1)]), 10);
    assert.deepEqual(out.pages.map((p) => [p.page_title, p.views]), [['(not set)', 7], ['Home', 3]]);
    assert.equal(out.pages.reduce((a, p) => a + p.views, 0), 10, 'every view is still accounted for');
  });

  test('a very long title is bounded', () => {
    assert.ok(readPagesReport(response([row('x'.repeat(2000), 1, 1)]), 1).pages[0].page_title.length <= 300);
  });

  test('a list that covers the day reconciles; a top-N that does not is reported as incomplete, not as the whole site', () => {
    assert.equal(readPagesReport(response([row('A', 60, 1), row('B', 40, 1)]), 100).reconciliation.complete, true);
    const partial = readPagesReport(response([row('A', 60, 1)]), 100);
    assert.equal(partial.reconciliation.complete, false);
    assert.equal(partial.reconciliation.shortfallRatio, 0.4);
  });

  test('with no day total to compare against, reconciliation is null (cannot check), never "complete"', () => {
    assert.equal(readPagesReport(response([row('A', 1, 1)]), 0).reconciliation, null);
    assert.equal(readPagesReport(response([row('A', 1, 1)]), null).reconciliation, null);
  });

  test("Google's withheld and (other) flags are read from the response metadata", () => {
    const out = readPagesReport(response([row('A', 1, 1)], { subjectToThresholding: true, dataLossFromOtherRow: true }), 1);
    assert.equal(out.meta.thresholded, true);
    assert.equal(out.meta.otherRowPresent, true);
  });

  test('a response with no rows is an empty list, not an error', () => {
    assert.deepEqual(readPagesReport({ rows: undefined, metadata: {} }, 5).pages, []);
    assert.deepEqual(readPagesReport(undefined, 5).pages, []);
  });
});

describe('summarizePages', () => {
  test('records what was listed against the day total and the flags', () => {
    const q = summarizePages(readPagesReport(response([row('A', 60, 1)], { subjectToThresholding: true }), 100));
    assert.deepEqual(q, { listedViews: 60, totalViews: 100, thresholded: true, otherRowPresent: false, sampled: false });
  });

  test('no day total stores null, not 0', () => {
    assert.equal(summarizePages(readPagesReport(response([row('A', 1, 1)]), 0)).totalViews, null);
  });

  test('the per-day cap is the documented 25', () => assert.equal(PAGES_PER_DAY, 25));
});
