import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shiftYmd, daysBetween, presetRange, rangeKeyFor, compareRange, isYmd, compact, pctDelta, paginate, buildInsights, seriesTotals } from './overview-view.js';

describe('date ranges', () => {
  test('shiftYmd goes back by days in UTC', () => {
    assert.equal(shiftYmd('2026-11-03', 7), '2026-10-27');
    assert.equal(shiftYmd('2026-03-01', 1), '2026-02-28');
  });
  test('presets count back from the newest day', () => {
    assert.deepEqual(presetRange('2026-11-03', '28'), { start: '2026-10-06', end: '2026-11-03' });
    assert.deepEqual(presetRange('2026-11-03', 'all', '2025-01-01'), { start: '2025-01-01', end: '2026-11-03' });
    assert.equal(presetRange('2026-11-03', 'all', null), null);
    assert.equal(presetRange('2026-11-03', 'nope'), null);
  });
  test('rangeKeyFor finds the preset or says custom', () => {
    assert.equal(rangeKeyFor('2026-10-06', '2026-11-03', '2026-11-03', null), '28');
    assert.equal(rangeKeyFor('2026-10-07', '2026-11-03', '2026-11-03', null), 'custom');
    assert.equal(rangeKeyFor('2026-10-06', '2026-11-02', '2026-11-03', null), 'custom');
    assert.equal(rangeKeyFor('2025-01-01', '2026-11-03', '2026-11-03', '2025-01-01'), 'all');
  });
  test('compare: previous period has the same length and ends the day before', () => {
    const r = compareRange('prev', '2026-10-06', '2026-11-03');
    assert.equal(r.end, '2026-10-05');
    assert.equal(daysBetween(r.start, r.end), daysBetween('2026-10-06', '2026-11-03'));
  });
  test('compare: same period last year, none, and custom', () => {
    assert.deepEqual(compareRange('year', '2026-10-06', '2026-11-03'), { start: '2025-10-06', end: '2025-11-03' });
    assert.equal(compareRange('none', '2026-10-06', '2026-11-03'), null);
    assert.deepEqual(compareRange('custom', 'a', 'b', { start: '2026-01-01', end: '2026-01-31' }), { start: '2026-01-01', end: '2026-01-31' });
    assert.equal(compareRange('custom', 'a', 'b', { start: '2026-02-01', end: '2026-01-31' }), null);
    assert.equal(compareRange('custom', 'a', 'b', null), null);
  });
  test('isYmd rejects bad dates', () => {
    assert.equal(isYmd('2026-02-30'), false);
    assert.equal(isYmd('2026-2-3'), false);
    assert.equal(isYmd('2026-10-31'), true);
  });
});

describe('numbers', () => {
  test('compact', () => {
    assert.equal(compact(1470), '1,470');
    assert.equal(compact(54200), '54.2K');
    assert.equal(compact(2300000), '2.3M');
    assert.equal(compact(null), '0');
  });
  test('pctDelta', () => {
    assert.equal(pctDelta(112, 100), 12);
    assert.equal(pctDelta(5, 0), null);
  });
  test('paginate clamps the page and counts rows', () => {
    const rows = Array.from({ length: 23 }, (_, i) => i);
    assert.deepEqual(paginate(rows, 1, 10), { rows: rows.slice(0, 10), page: 1, pages: 3, from: 1, to: 10, total: 23 });
    assert.equal(paginate(rows, 9, 10).page, 3);
    assert.equal(paginate(rows, 3, 10).to, 23);
    assert.deepEqual(paginate([], 1, 10), { rows: [], page: 1, pages: 1, from: 0, to: 0, total: 0 });
  });
});

describe('seriesTotals', () => {
  test('sums counts, derives CTR and weights position by impressions', () => {
    const r = seriesTotals([
      { impressions: 100, clicks: 10, position: 2, users: 5, sessions: 6, conversions: 1 },
      { impressions: 300, clicks: 20, position: 6, users: 7, sessions: 9, conversions: 0 },
    ]);
    assert.equal(r.impressions, 400);
    assert.equal(r.clicks, 30);
    assert.equal(r.ctr, 0.075);
    assert.equal(r.position, 5);
    assert.equal(r.sessions, 15);
  });
  test('a day with no position is skipped, not counted as rank 0', () => {
    const r = seriesTotals([{ impressions: 100, clicks: 1, position: 4 }, { impressions: 900, clicks: 0, position: null }]);
    assert.equal(r.position, 4);
    assert.equal(seriesTotals([]).position, null);
    assert.equal(seriesTotals([]).ctr, 0);
  });
});

describe('buildInsights', () => {
  const queries = [
    { dim_value: 'ai agents', clicks: 100, impressions: 2000, avg_position: 4 },
    { dim_value: 'rag pipeline', clicks: 5, impressions: 1000, avg_position: 9 },
    { dim_value: 'gaas', clicks: 3, impressions: 400, avg_position: 12 },
  ];
  test('nothing to say with no data', () => {
    assert.deepEqual(buildInsights({}), []);
  });
  test('low CTR names the weak query and the average', () => {
    const r = buildInsights({ queries });
    const low = r.find((i) => i.key === 'low-ctr');
    assert.ok(low);
    assert.match(low.parts.map((p) => p.t).join(''), /"rag pipeline"/);
  });
  test('zero clicks outranks everything else', () => {
    const q = [{ dim_value: 'a', clicks: 0, impressions: 500 }, { dim_value: 'b', clicks: 0, impressions: 300 }];
    const r = buildInsights({ queries: q, pages: [{ dim_value: 'https://x.com/p/', impressions: 500 }], totalImpressions: 800 });
    assert.equal(r[0].key, 'zero-clicks');
    assert.equal(r[0].impact, 'high');
  });
  test('a page with a big share is an opportunity, a small share is skipped', () => {
    const big = buildInsights({ pages: [{ dim_value: 'https://x.com/a/', impressions: 900 }], totalImpressions: 1000 });
    assert.equal(big.find((i) => i.key === 'top-page').impact, 'high');
    const small = buildInsights({ pages: [{ dim_value: 'https://x.com/a/', impressions: 100 }], totalImpressions: 1000 });
    assert.equal(small.find((i) => i.key === 'top-page'), undefined);
  });
  test('queries ranking 6 to 15 become a growth idea; fewer fall back to the expansion note', () => {
    assert.equal(buildInsights({ queries }).find((i) => i.tag === 'growth').key, 'page-one');
    const two = buildInsights({ queries: [queries[0], { dim_value: 'x', clicks: 1, impressions: 90, avg_position: 20 }] });
    assert.equal(two.find((i) => i.tag === 'growth').key, 'expand');
  });
  test('a dominant channel shows only at 70% or more', () => {
    assert.ok(buildInsights({ channels: [{ channel: 'Organic Search', sessions: 80 }, { channel: 'Direct', sessions: 20 }] }).find((i) => i.key === 'channel'));
    assert.equal(buildInsights({ channels: [{ channel: 'Organic Search', sessions: 50 }, { channel: 'Direct', sessions: 50 }] }).find((i) => i.key === 'channel'), undefined);
  });
  test('never more than the limit, most impactful first', () => {
    const r = buildInsights({ queries, pages: [{ dim_value: 'https://x.com/a/', impressions: 900 }], totalImpressions: 1000, channels: [{ channel: 'Organic Search', sessions: 90 }, { channel: 'Direct', sessions: 10 }] }, 3);
    assert.equal(r.length, 3);
    const order = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < r.length; i++) assert.ok(order[r[i - 1].impact] <= order[r[i].impact]);
  });
});
