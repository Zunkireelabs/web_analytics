import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { upsertGa4 } from './upsert.js';
import { getTopPages, listDaysMissingPages, recordPagesQuality, replaceGa4PagesForDay } from './ga4-pages.js';
import { readPagesReport, summarizePages } from '../ingest/ga4.js';

// Real DB (migration 245). The rules under test: a re-fetched day REPLACES its list; a day whose pages were not fetched
// keeps what it had; views (never users) are summed; a page with no previous-period views has no change figure rather
// than an infinite one; and a top-N that does not cover the period's views says so in words.

const siteIds = [];
async function makeSite(label) {
  const stamp = `ga4-pages-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone) VALUES ('ga4-pages.db.test.js fixture', $1, $2, 'UTC') RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}
const totals = { users: 10, new_users: 5, sessions: 12, engaged_sessions: 8, avg_engagement_time: 30, conversions: 1, bounce_rate: 0.4 };
// A page list built from a REAL-shape runReport response, so the stored shape is the one the ingest actually produces.
const list = (entries, dayTotal) => {
  const rep = readPagesReport({
    rows: entries.map(([t, v, u]) => ({ dimensionValues: [{ value: t }], metricValues: [{ value: String(v) }, { value: String(u) }] })),
    metadata: {},
  }, dayTotal);
  return { pages: rep.pages, quality: summarizePages(rep) };
};
const ingestDay = (siteId, date, entries, dayTotal) => {
  const { pages, quality } = list(entries, dayTotal);
  return upsertGa4(siteId, { date, totals, channels: [], pages, dataQuality: { confidence: 'complete', flags: {}, notes: [], pages: quality } });
};
const count = async (s) => (await query('SELECT COUNT(*)::int n FROM ga4_pages WHERE site_id = $1', [s])).rows[0].n;

after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM ga4_pages WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM ga4_daily WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

describe('ga4_pages (real DB)', () => {
  test("upsertGa4 stores the day's page list, and a re-ingest replaces it rather than adding to it", async () => {
    const s = await makeSite('replace');
    await ingestDay(s, '2026-10-01', [['Home', 10, 5], ['Contact', 4, 3]], 14);
    await ingestDay(s, '2026-10-01', [['Home', 12, 6]], 12);
    const { rows } = await query('SELECT page_title, views FROM ga4_pages WHERE site_id = $1 ORDER BY page_title', [s]);
    assert.deepEqual(rows, [{ page_title: 'Home', views: 12 }]);
  });

  test("an ingest that did not fetch pages (null) leaves the day's earlier list alone; an empty list clears it", async () => {
    const s = await makeSite('null');
    await ingestDay(s, '2026-10-01', [['Home', 10, 5]], 10);
    await upsertGa4(s, { date: '2026-10-01', totals, channels: [], pages: null });
    assert.equal(await count(s), 1);
    await upsertGa4(s, { date: '2026-10-01', totals, channels: [], pages: [] });
    assert.equal(await count(s), 0);
  });

  test('the existing quality verdict is untouched by page coverage', async () => {
    const s = await makeSite('verdict');
    await ingestDay(s, '2026-10-01', [['Home', 1, 1]], 100); // top-N covers 1% of the day, by construction
    const { rows } = await query('SELECT data_confidence, data_quality FROM ga4_daily WHERE site_id = $1', [s]);
    assert.equal(rows[0].data_confidence, 'complete');
    assert.equal(rows[0].data_quality.pages.totalViews, 100);
  });

  test('getTopPages sums views across days, orders by views, and compares with the window just before', async () => {
    const s = await makeSite('range');
    // previous window 2026-09-29..2026-10-01 (3 days), current 2026-10-02..2026-10-04
    await ingestDay(s, '2026-09-30', [['Home', 100, 50], ['Contact', 40, 30], ['Gone', 5, 5]], 145);
    await ingestDay(s, '2026-10-02', [['Home', 60, 30], ['Contact', 10, 8], ['New page', 7, 6]], 77);
    await ingestDay(s, '2026-10-03', [['Home', 60, 31], ['Contact', 10, 9]], 70);
    const out = await getTopPages(s, { start: '2026-10-02', end: '2026-10-04' });
    assert.deepEqual(out.previous, { start: '2026-09-29', end: '2026-10-01', days: 1, daysInRange: 3 });
    assert.deepEqual(out.current, { start: '2026-10-02', end: '2026-10-04', days: 2, daysInRange: 3 });
    const by = Object.fromEntries(out.pages.map((p) => [p.title, p]));
    assert.deepEqual(out.pages.map((p) => p.title), ['Home', 'Contact', 'New page']);
    assert.equal(by.Home.views, 120);
    assert.equal(by.Home.prev_views, 100);
    assert.equal(by.Home.change_pct, 20);
    assert.equal(by.Contact.change_pct, -50);
    assert.equal(by['New page'].prev_views, null);
    assert.equal(by['New page'].change_pct, null, 'no baseline is not +infinity');
  });

  test('users are never in the response (summing daily uniques double-counts a returning person)', async () => {
    const s = await makeSite('users');
    await ingestDay(s, '2026-10-02', [['Home', 5, 5]], 5);
    const out = await getTopPages(s, { start: '2026-10-02', end: '2026-10-02' });
    assert.deepEqual(Object.keys(out.pages[0]).sort(), ['change_pct', 'prev_views', 'title', 'views']);
  });

  test('an explicit compare window is honoured (the Overview compare modes)', async () => {
    const s = await makeSite('compare');
    await ingestDay(s, '2025-10-02', [['Home', 50, 5]], 50);
    await ingestDay(s, '2026-10-02', [['Home', 75, 5]], 75);
    const out = await getTopPages(s, { start: '2026-10-02', end: '2026-10-02', compareStart: '2025-10-02', compareEnd: '2025-10-02' });
    assert.equal(out.pages[0].prev_views, 50);
    assert.equal(out.pages[0].change_pct, 50);
    assert.equal(out.previous.start, '2025-10-02');
  });

  test("only the top 10 are returned, and another site's pages never appear", async () => {
    const a = await makeSite('limit-a');
    const b = await makeSite('limit-b');
    await ingestDay(a, '2026-10-02', Array.from({ length: 15 }, (_, i) => [`Page ${String(i).padStart(2, '0')}`, 100 - i, 1]), 1500);
    await ingestDay(b, '2026-10-02', [['Other site only', 9999, 1]], 9999);
    const out = await getTopPages(a, { start: '2026-10-02', end: '2026-10-02' });
    assert.equal(out.pages.length, 10);
    assert.ok(!out.pages.some((p) => p.title === 'Other site only'));
  });

  test('a project with nothing ingested gets an empty list, zero days, and no claim of completeness', async () => {
    const s = await makeSite('empty');
    const out = await getTopPages(s, { start: '2026-10-02', end: '2026-10-28' });
    assert.deepEqual(out.pages, []);
    assert.equal(out.current.days, 0);
    assert.equal(out.dataQuality.confidence, 'unassessed');
  });

  test('coverage: a top-N that covers the period reads as complete with no note', async () => {
    const s = await makeSite('cov-ok');
    await ingestDay(s, '2026-10-02', [['A', 60, 1], ['B', 40, 1]], 100);
    const out = await getTopPages(s, { start: '2026-10-02', end: '2026-10-02' });
    assert.equal(out.dataQuality.confidence, 'complete');
    assert.deepEqual(out.dataQuality.notes, []);
    assert.equal(out.dataQuality.listedShare, 1);
  });

  test('coverage: a top-N that misses a big share says so in words', async () => {
    const s = await makeSite('cov-partial');
    await ingestDay(s, '2026-10-02', [['A', 60, 1]], 100);
    const out = await getTopPages(s, { start: '2026-10-02', end: '2026-10-02' });
    assert.equal(out.dataQuality.confidence, 'partial');
    assert.equal(out.dataQuality.listedShare, 0.6);
    assert.match(out.dataQuality.notes[0], /other 40% of views/);
  });

  test('coverage: withheld rows are reported', async () => {
    const s = await makeSite('cov-withheld');
    const rep = readPagesReport({ rows: [{ dimensionValues: [{ value: 'A' }], metricValues: [{ value: '100' }, { value: '1' }] }], metadata: { subjectToThresholding: true } }, 100);
    await upsertGa4(s, { date: '2026-10-02', totals, channels: [], pages: rep.pages, dataQuality: { confidence: 'partial', flags: {}, notes: [], pages: summarizePages(rep) } });
    const out = await getTopPages(s, { start: '2026-10-02', end: '2026-10-02' });
    assert.match(out.dataQuality.notes.join(' '), /withheld some pages on 1 day/);
  });

  test('listDaysMissingPages returns days with traffic and no list, newest first; recordPagesQuality fills a backfilled day', async () => {
    const s = await makeSite('missing');
    await upsertGa4(s, { date: '2026-10-01', totals, channels: [] });                                  // traffic, no list
    await upsertGa4(s, { date: '2026-10-02', totals, channels: [] });                                  // traffic, no list
    await upsertGa4(s, { date: '2026-10-03', totals: { ...totals, sessions: 0 }, channels: [] });       // no traffic: nothing to list
    await ingestDay(s, '2026-10-04', [['A', 1, 1]], 1);                                                 // already has one
    assert.deepEqual(await listDaysMissingPages(s, '2026-10-01', '2026-10-04', 40), ['2026-10-02', '2026-10-01']);

    const { pages, quality } = list([['A', 3, 1]], 3);
    await replaceGa4PagesForDay(s, '2026-10-02', pages);
    await recordPagesQuality(s, '2026-10-02', quality);
    assert.deepEqual(await listDaysMissingPages(s, '2026-10-01', '2026-10-04', 40), ['2026-10-01']);
    const { rows } = await query(`SELECT data_quality->'pages' AS p FROM ga4_daily WHERE site_id = $1 AND date = '2026-10-02'`, [s]);
    assert.equal(rows[0].p.totalViews, 3);
  });

  test('migration 245 left row-level security on', async () => {
    const { rows } = await query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'ga4_pages'`);
    assert.equal(rows[0].relrowsecurity, true);
  });
});

describe('review fixes (real DB)', () => {
  test('a failed INSERT leaves the day\'s earlier list in place (the replace is one transaction)', async () => {
    const s = await makeSite('tx');
    await ingestDay(s, '2026-10-01', [['Home', 10, 5], ['Contact', 4, 3]], 14);
    // views violates the table's CHECK (views >= 0), so the INSERT half fails after the DELETE half has run.
    await assert.rejects(replaceGa4PagesForDay(s, '2026-10-01', [{ page_title: 'Bad', views: -1, users: 0 }]));
    const { rows } = await query('SELECT page_title FROM ga4_pages WHERE site_id = $1 ORDER BY page_title', [s]);
    assert.deepEqual(rows.map((r) => r.page_title), ['Contact', 'Home'], 'the day must not be left empty');
  });

  test('a successful replace still swaps the whole list, and an empty list still clears the day', async () => {
    const s = await makeSite('tx-ok');
    await ingestDay(s, '2026-10-01', [['Home', 10, 5], ['Contact', 4, 3]], 14);
    await replaceGa4PagesForDay(s, '2026-10-01', [{ page_title: 'Only', views: 1, users: 1 }]);
    assert.deepEqual((await query('SELECT page_title FROM ga4_pages WHERE site_id = $1', [s])).rows, [{ page_title: 'Only' }]);
    await replaceGa4PagesForDay(s, '2026-10-01', []);
    assert.equal(await count(s), 0);
  });

  test('a day whose pages fetch failed keeps its stored page-coverage note (data_quality.pages is merged, not overwritten)', async () => {
    const s = await makeSite('merge');
    await ingestDay(s, '2026-10-02', [['A', 60, 1]], 100);   // stores pages quality: top-N covers 60%
    // Re-ingest the same day: pages fetch failed (pages: null, no quality.pages), but the rest of the day re-assessed.
    await upsertGa4(s, { date: '2026-10-02', totals, channels: [], pages: null, dataQuality: { confidence: 'complete', flags: {}, notes: ['fresh note'] } });
    const { rows } = await query(`SELECT data_quality FROM ga4_daily WHERE site_id = $1`, [s]);
    assert.equal(rows[0].data_quality.notes[0], 'fresh note', 'the rest of the day is still refreshed');
    assert.equal(rows[0].data_quality.pages.totalViews, 100, 'but the page coverage note survives');
    const out = await getTopPages(s, { start: '2026-10-02', end: '2026-10-02' });
    assert.equal(out.pages.length, 1);
    assert.equal(out.dataQuality.confidence, 'partial', 'still reported from the stored coverage, not "unassessed"');
  });

  test('a successful pages fetch still replaces the stored coverage with the new one', async () => {
    const s = await makeSite('merge-new');
    await ingestDay(s, '2026-10-02', [['A', 60, 1]], 100);
    await ingestDay(s, '2026-10-02', [['A', 100, 1]], 100);
    const { rows } = await query(`SELECT data_quality->'pages' AS p FROM ga4_daily WHERE site_id = $1`, [s]);
    assert.equal(rows[0].p.listedViews, 100);
  });

  test('a day that never had a coverage note does not gain a null "pages" key', async () => {
    const s = await makeSite('merge-none');
    await upsertGa4(s, { date: '2026-10-02', totals, channels: [], dataQuality: { confidence: 'complete', flags: {}, notes: [] } });
    await upsertGa4(s, { date: '2026-10-02', totals, channels: [], pages: null, dataQuality: { confidence: 'complete', flags: {}, notes: [] } });
    const { rows } = await query(`SELECT data_quality ? 'pages' AS has FROM ga4_daily WHERE site_id = $1`, [s]);
    assert.equal(rows[0].has, false);
  });

  test('a re-ingest with no quality at all still leaves the stored verdict and coverage alone', async () => {
    const s = await makeSite('merge-null');
    await ingestDay(s, '2026-10-02', [['A', 60, 1]], 100);
    await upsertGa4(s, { date: '2026-10-02', totals, channels: [] });
    const { rows } = await query(`SELECT data_confidence, data_quality->'pages'->>'totalViews' AS tv FROM ga4_daily WHERE site_id = $1`, [s]);
    assert.equal(rows[0].data_confidence, 'complete');
    assert.equal(rows[0].tv, '100');
  });
});
