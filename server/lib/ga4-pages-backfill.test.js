import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { backfillGa4Pages } from './ga4-pages-backfill.js';
import { readPagesReport, summarizePages } from '../ingest/ga4.js';

// Fetch results are built with the real readPagesReport/summarizePages (from a real-shape response), not hand-written.
const realResult = (date) => {
  const rep = readPagesReport({ rows: [{ dimensionValues: [{ value: 'Home' }], metricValues: [{ value: '9' }, { value: '4' }] }], metadata: {} }, 9);
  return { date, pages: rep.pages, quality: summarizePages(rep) };
};
const NOW = new Date('2026-11-06T09:00:00Z');
const site = { id: 7, ga4_property_id: '123' };

function harness({ missing = [], failOn = [] } = {}) {
  const calls = { fetched: [], replaced: [], recorded: [], listArgs: null };
  return {
    calls,
    deps: {
      listDaysMissingPages: async (...args) => { calls.listArgs = args; return missing; },
      fetchGa4PagesForDate: async (_s, date) => { calls.fetched.push(date); if (failOn.includes(date)) throw new Error('quota'); return realResult(date); },
      replaceGa4PagesForDay: async (id, date, pages) => { calls.replaced.push([id, date, pages.length]); },
      recordPagesQuality: async (id, date) => { calls.recorded.push([id, date]); },
    },
  };
}

describe('backfillGa4Pages', () => {
  test('fetches exactly the days the store says are missing, for the site, within yesterday back 35 days', async () => {
    const h = harness({ missing: ['2026-11-05', '2026-11-04'] });
    const out = await backfillGa4Pages(site, { now: NOW, deps: h.deps });
    assert.deepEqual(h.calls.fetched, ['2026-11-05', '2026-11-04']);
    assert.equal(out.fetched, 2);
    assert.deepEqual(h.calls.listArgs.slice(0, 3), [7, '2026-10-02', '2026-11-05']);
    assert.deepEqual(h.calls.recorded.map((r) => r[1]), ['2026-11-05', '2026-11-04']);
  });

  test('today is never fetched here (it is partial, and the daily run re-fetches it)', async () => {
    const h = harness();
    await backfillGa4Pages(site, { now: NOW, deps: h.deps });
    assert.equal(h.calls.listArgs[2], '2026-11-05');
  });

  test('nothing missing means no GA4 calls at all', async () => {
    const h = harness({ missing: [] });
    const out = await backfillGa4Pages(site, { now: NOW, deps: h.deps });
    assert.equal(h.calls.fetched.length, 0);
    assert.equal(out.fetched, 0);
    assert.equal(out.ok, true);
  });

  test('one failing day does not stop the others or throw', async () => {
    const h = harness({ missing: ['2026-11-05', '2026-11-04', '2026-11-03'], failOn: ['2026-11-04'] });
    const out = await backfillGa4Pages(site, { now: NOW, deps: h.deps });
    assert.equal(out.fetched, 2);
    assert.equal(out.failed, 1);
    assert.deepEqual(h.calls.replaced.map((r) => r[1]), ['2026-11-05', '2026-11-03']);
  });

  test('a project with no GA4 property does nothing and says why', async () => {
    const h = harness({ missing: ['2026-11-05'] });
    const out = await backfillGa4Pages({ id: 7, ga4_property_id: null }, { now: NOW, deps: h.deps });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_ga4_property');
    assert.equal(h.calls.fetched.length, 0);
  });

  test('a store failure is returned, never thrown into the daily ingest', async () => {
    const out = await backfillGa4Pages(site, { now: NOW, deps: { listDaysMissingPages: async () => { throw new Error('db down'); } } });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'error');
  });

  test('the window is bounded however many days are asked for', async () => {
    const h = harness();
    await backfillGa4Pages(site, { now: NOW, days: 100000, deps: h.deps });
    assert.equal(h.calls.listArgs[1], '2026-08-08'); // 90 days ending 2026-11-05
  });
});
