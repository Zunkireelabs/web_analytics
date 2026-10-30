import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avgPosition, periodStats, deltaFor, positionDelta, tilesFor, headlineFor, bettermentTable, topSearchesSection } from './doc-model.js';

const rows = [
  { clicks: 100, impressions: 1000, position: 10, users: 40, sessions: 50 },
  { clicks: 50, impressions: 3000, position: 6, users: 20, sessions: 25 },
];

test('average position is weighted by impressions, and null with none', () => {
  assert.equal(avgPosition(rows), (10 * 1000 + 6 * 3000) / 4000);
  assert.equal(avgPosition([{ position: 5, impressions: 0 }]), null);
});

test('deltas say what happened and never invent a comparison', () => {
  assert.deepEqual(deltaFor(120, 100, 'prior week'), { delta: '▲ 20% vs prior week', tone: 'good' });
  assert.deepEqual(deltaFor(80, 100, 'prior week'), { delta: '▼ 20% vs prior week', tone: 'bad' });
  assert.equal(deltaFor(5, 0, 'prior week').delta, 'no prior period to compare');
  assert.equal(deltaFor(5, null, 'prior week').tone, 'flat');
  assert.equal(positionDelta(8.6, 9.3, 'prior week').delta, '▲ 0.7 better');
  assert.equal(positionDelta(9.3, 8.6, 'prior week').tone, 'bad');
});

test('tiles are impressions, clicks, position and users; the headline follows the clicks', () => {
  const cur = periodStats(rows), prev = { ...cur, clicks: 100, impressions: 3000, users: 50, position: 7 };
  const tiles = tilesFor(cur, prev, 'prior week');
  assert.deepEqual(tiles.map((t) => t.label), ['Impressions', 'Clicks', 'Avg position', 'Users']);
  assert.equal(tiles[0].value, '4,000');
  assert.equal(headlineFor(cur, prev, 'this week', 'the prior week'), 'Clicks are up 50% on the prior week');
  assert.match(headlineFor({ ...cur, clicks: 50 }, prev, 'this week', 'the prior week'), /^A quieter week: clicks are down 50%/);
  assert.match(headlineFor(cur, null, 'this week', 'the prior week'), /^150 clicks and 4,000 impressions this week$/);
});

const baseline = { daysOfHistory: 30, clicks: 300, impressions: 3000, healthScore: 71 };
const cur = { clicks: 700, impressions: 7000, days: 7 };
const labels = { prev: 'Last week', cur: 'This week' };

test('since-baseline compares per day, like for like, with the health score when both exist', () => {
  const t = bettermentTable({ baseline, baselineAt: '2026-10-12', periodEnd: '2026-10-26', cur, prev: { clicks: 490, impressions: 4900, days: 7 }, currentHealth: 86, labels });
  assert.equal(t.table.head[4], 'Since baseline');
  const clicks = t.table.rows[0]; // baseline 10/day, now 100/day
  assert.deepEqual([clicks[0], clicks[1], clicks[2], clicks[3]], ['Clicks per day', '10.0', '70.0', '100.0'.replace('100.0', '100')]);
  assert.deepEqual(clicks[4], { t: '▲ +900%', tone: 'good' });
  assert.deepEqual(t.table.rows.at(-1), ['Health score', '71', '—', '86', { t: '▲ +15', tone: 'good' }]);
});

test('no honest comparison means no table', () => {
  const base = { baselineAt: '2026-10-12', periodEnd: '2026-10-26', cur, labels };
  assert.equal(bettermentTable({ ...base, baseline: null }), null);
  assert.equal(bettermentTable({ ...base, baseline: { ...baseline, daysOfHistory: 3 } }), null);
  assert.equal(bettermentTable({ ...base, baseline, baselineAt: '2026-11-02' }), null, 'baseline taken after the period ended');
  const noHealth = bettermentTable({ ...base, baseline: { ...baseline, healthScore: null }, currentHealth: 86 });
  assert.equal(noHealth.table.rows.length, 2);
});

test('top searches section is absent when there are none', () => {
  assert.equal(topSearchesSection([]), null);
  assert.equal(topSearchesSection([{ dim_value: 'seo report', clicks: 12 }]).table.rows[0][0], 'seo report');
});

test('bettermentTable accepts the Date the database returns for the baseline time', () => {
  const t = bettermentTable({ baseline: { daysOfHistory: 30, clicks: 300, impressions: 3000 }, baselineAt: new Date('2026-09-15T09:00:00Z'), periodEnd: '2026-10-25',
    cur: { clicks: 700, impressions: 7000, days: 7 }, prev: null, currentHealth: null, labels: { prev: 'Last week', cur: 'This week' } });
  assert.ok(t, 'a baseline taken before the period must produce the table');
  assert.equal(bettermentTable({ baseline: { daysOfHistory: 30, clicks: 1, impressions: 1 }, baselineAt: new Date('2026-11-01T00:00:00Z'), periodEnd: '2026-10-25', cur: { clicks: 1, impressions: 1, days: 7 }, prev: null, labels: { prev: 'a', cur: 'b' } }), null);
});
