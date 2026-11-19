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
      },
    });
    assert.deepEqual(seen.fetch, [7, '2026-11-11', '2026-11-18']);
    assert.deepEqual(seen.up, [7, 1]);
    assert.equal(out.ok, true);
  });
  test('a Google failure is returned, not thrown, and stores nothing', async () => {
    let stored = false;
    const out = await refreshScreenDaysForSite(site, {
      now,
      deps: { query: async () => ({ rows: [] }), fetchDays: async () => { throw new Error('invalid_grant'); }, upsert: async () => { stored = true; } },
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
