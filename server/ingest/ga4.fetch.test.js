import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// fetchGa4ForDate run for real, with only the Google client replaced. Responses use the real v1beta RunReportResponse
// shape (values are { value: '<string>' }, `metadata` is a ResponseMetaData), and are chosen by the request's own
// dimension, so a wrong request (dimension name, metric order, limit) fails here instead of in production.
const requests = [];
let failPageTitle = false;
let pageRows = [];
let dayViews = '100';

const v = (x) => ({ value: String(x) });
const response = (rows, metadata = {}) => ({ rows, rowCount: rows.length, metadata: { currencyCode: 'USD', timeZone: 'UTC', ...metadata }, kind: 'analyticsData#runReport' });

class FakeClient {
  async runReport(request) {
    requests.push(request);
    const dim = request.dimensions?.[0]?.name;
    if (!dim && request.metrics.length === 1) {
      assert.equal(request.metrics[0].name, 'screenPageViews');   // the backfill path's own day-total query
      return [response([{ metricValues: [v(dayViews)] }])];
    }
    if (!dim) {
      // totals: users, newUsers, sessions, engagedSessions, averageSessionDuration, conversions, bounceRate, screenPageViews
      assert.deepEqual(request.metrics.map((m) => m.name), ['totalUsers', 'newUsers', 'sessions', 'engagedSessions', 'averageSessionDuration', 'conversions', 'bounceRate', 'screenPageViews']);
      return [response([{ metricValues: [v(40), v(20), v(50), v(30), v(12.5), v(2), v(0.4), v(dayViews)] }])];
    }
    if (dim === 'pageTitle') {
      if (failPageTitle) throw new Error('RESOURCE_EXHAUSTED: quota');
      return [response(pageRows.map(([t, views, users]) => ({ dimensionValues: [v(t)], metricValues: [v(views), v(users)] })))];
    }
    // every other breakdown: one row that accounts for the whole day, so the established verdict stays clean
    return [response([{ dimensionValues: [v('x')], metricValues: [v(50), v(40)] }])];
  }
}

mock.module('@google-analytics/data', { namedExports: { BetaAnalyticsDataClient: FakeClient } });
mock.module(resolve('../auth/google.js'), { namedExports: { getGa4ClientOptionsAsync: async () => ({}) } });
const { fetchGa4ForDate, fetchGa4PagesForDate } = await import('./ga4.js');

const site = { id: 4242, ga4_property_id: '999' };
beforeEach(() => { requests.length = 0; failPageTitle = false; dayViews = '100'; pageRows = [['Contact us', 233, 150], ['House Removals, Dorking', 412, 300]]; });

describe('fetchGa4ForDate with top pages', () => {
  test('asks GA4 for the 25 most viewed page titles, ordered by views', async () => {
    await fetchGa4ForDate(site, '2026-10-02');
    const req = requests.find((r) => r.dimensions?.[0]?.name === 'pageTitle');
    assert.deepEqual(req.metrics.map((m) => m.name), ['screenPageViews', 'totalUsers']);
    assert.equal(req.limit, 25);
    assert.deepEqual(req.orderBys, [{ metric: { metricName: 'screenPageViews' }, desc: true }]);
    assert.equal(req.property, 'properties/999');
  });

  test("returns the day's pages, most viewed first, and the day's total views", async () => {
    dayViews = '645';
    const out = await fetchGa4ForDate(site, '2026-10-02');
    assert.equal(out.totals.views, 645);
    assert.deepEqual(out.pages.map((p) => p.page_title), ['House Removals, Dorking', 'Contact us']);
    assert.equal(out.dataQuality.pages.listedViews, 645);
    assert.equal(out.dataQuality.pages.totalViews, 645);
  });

  test("a top-N that misses most of the day is recorded as such but does NOT downgrade the day's verdict", async () => {
    dayViews = '5000';
    const out = await fetchGa4ForDate(site, '2026-10-02');
    assert.equal(out.dataQuality.pages.totalViews, 5000);
    assert.ok(out.dataQuality.pages.listedViews < 5000);
    assert.equal(out.dataQuality.confidence, 'complete');
  });

  test('a failing page-title query costs only the page list: the rest of the day still comes back', async () => {
    failPageTitle = true;
    const out = await fetchGa4ForDate(site, '2026-10-02');
    assert.equal(out.pages, null);
    assert.equal(out.dataQuality.pages, undefined);
    assert.equal(out.totals.sessions, 50);
    assert.ok(out.countries.length > 0);
  });

  test('fetchGa4PagesForDate on its own (the backfill path) fetches the day total itself when not given one', async () => {
    dayViews = '645';
    const out = await fetchGa4PagesForDate(site, '2026-10-02');
    assert.equal(out.quality.totalViews, 645);
    assert.equal(out.pages.length, 2);
    assert.equal(requests.length, 2, 'one total query, one page-title query');
  });

  test('fetchGa4PagesForDate with a known total makes just the one page-title query', async () => {
    await fetchGa4PagesForDate(site, '2026-10-02', 645);
    assert.equal(requests.length, 1);
  });
});
