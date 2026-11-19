import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { screenWindow, refreshScreenDaysForSite, REFRESH_DAYS, HISTORY_DAYS } from './gsc-screen.js';

const now = new Date('2026-11-18T10:00:00Z');

describe('which days are read', () => {
  test('the first time: the whole history up to today', () => {
    const w = screenWindow({ hasRows: false, now });
    assert.equal(w.end, '2026-11-18');
    assert.equal(w.start, new Date(now.getTime() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10));
  });
  test('afterwards: only the recent days, so they pick up Google finalising them', () => {
    assert.deepEqual(screenWindow({ hasRows: true, now }), { start: '2026-11-11', end: '2026-11-18' });
    assert.equal(REFRESH_DAYS, 7);
  });
});

describe('refreshing one project', () => {
  const site = { id: 7, name: 'x' };
  test('reads the window and stores every returned day', async () => {
    const seen = {};
    const out = await refreshScreenDaysForSite(site, {
      now,
      deps: {
        query: async () => ({ rows: [{}] }),
        fetchDays: async (s, a, b) => { seen.fetch = [s.id, a, b]; return [{ date: '2026-11-17', clicks: 3, impressions: 90, ctr: 0.03, position: 8 }]; },
        upsert: async (id, days) => { seen.up = [id, days.length]; },
        deleteAfter: async (id, last) => { seen.del = [id, last]; return 1; },
      },
    });
    assert.deepEqual(seen.fetch, [7, '2026-11-11', '2026-11-18']);
    assert.deepEqual(seen.up, [7, 1]);
    assert.deepEqual(seen.del, [7, '2026-11-17']);   // anything newer than the last finalized day is removed
    assert.equal(out.ok, true);
    assert.equal(out.removed, 1);
  });
  test('a Google failure is returned, not thrown, and stores nothing', async () => {
    let stored = false;
    const out = await refreshScreenDaysForSite(site, {
      now,
      deps: { query: async () => ({ rows: [] }), fetchDays: async () => { throw new Error('invalid_grant'); }, upsert: async () => { stored = true; }, deleteAfter: async () => { stored = true; } },
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /invalid_grant/);
    assert.equal(stored, false);
  });
});

describe('an empty row for a day that has barely started', () => {
  test('is dropped on the last two days, kept as a real zero on older days', async () => {
    const { keepScreenDay } = await import('./gsc.js');
    const keep = keepScreenDay('2026-11-18');
    assert.equal(keep({ date: '2026-11-18', clicks: 0, impressions: 0 }), false);
    assert.equal(keep({ date: '2026-11-17', clicks: 0, impressions: 0 }), false);
    assert.equal(keep({ date: '2026-11-16', clicks: 0, impressions: 0 }), true);
    assert.equal(keep({ date: '2026-11-18', clicks: 0, impressions: 4 }), true);
  });
});

describe('the same days as the Search Console screen', () => {
  test('an empty answer from Google never deletes what is stored', async () => {
    let deleted = false;
    const out = await refreshScreenDaysForSite({ id: 7 }, {
      now, deps: { query: async () => ({ rows: [{}] }), fetchDays: async () => [], upsert: async () => {}, deleteAfter: async () => { deleted = true; return 9; } },
    });
    assert.equal(out.ok, true);
    assert.equal(deleted, false);
  });

  test('Google is asked for FINALIZED data (the screen ends on the last finalized day), and the answer is kept as returned', async () => {
    const { fetchGscScreenDays } = await import('./gsc.js');
    let body;
    // Row shape as returned by the real API on 2026-11-19 for SuperRank: keys is [date], numbers are plain.
    const client = { searchanalytics: { query: async ({ siteUrl, requestBody }) => { body = { siteUrl, ...requestBody }; return { data: { rows: [
      { keys: ['2026-11-16'], clicks: 2, impressions: 19, ctr: 0.105, position: 9.1 },
      { keys: ['2026-11-17'], clicks: 0, impressions: 15, ctr: 0, position: 11.4 },
    ] } }; } } };
    const days = await fetchGscScreenDays({ gsc_property: 'https://superrank.si/' }, '2026-10-21', '2026-11-19', { client });
    assert.equal(body.dataState, 'final');
    assert.deepEqual(body.dimensions, ['date']);
    assert.deepEqual(days.map((d) => [d.date, d.impressions]), [['2026-11-16', 19], ['2026-11-17', 15]]);
  });
});
