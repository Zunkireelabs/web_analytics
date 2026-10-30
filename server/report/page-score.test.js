import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePage, pageScoreRows, pageScoreSection } from './page-score.js';

const f = (page, priority) => ({ page, priority });

test('a page starts at 100 and loses points by priority, never below 0', () => {
  assert.equal(scorePage([]), 100);
  assert.equal(scorePage([f('a', 'high'), f('a', 'medium'), f('a', 'low')]), 100 - 12 - 6 - 2);
  assert.equal(scorePage(Array.from({ length: 20 }, () => f('a', 'high'))), 0);
  assert.equal(scorePage([{ page: 'a', priority: 'weird' }]), 100);
});

const baseline = [f('https://x.com/a', 'high'), f('https://x.com/a', 'high'), f('https://x.com/b', 'medium'), f('https://x.com/c', 'low'), f(null, 'high')];

test('only pages that improved are listed, biggest first, site-level findings ignored', () => {
  const latest = [f('https://x.com/a', 'high'), f('https://x.com/c', 'low')]; // a: 76 -> 88, b: 94 -> 100, c unchanged
  const rows = pageScoreRows(baseline, latest);
  assert.deepEqual(rows.map((r) => [r.page, r.before, r.now, r.change]), [['https://x.com/a', 76, 88, 12], ['https://x.com/b', 94, 100, 6]]);
});

test('a page the latest audit never reached is skipped, not assumed perfect', () => {
  const rows = pageScoreRows(baseline, [], { reached: new Set(['https://x.com/b']) });
  assert.deepEqual(rows.map((r) => r.page), ['https://x.com/b']);
});

test('the section needs two different finished audits and at least one improvement', () => {
  const runA = { id: 1 }, runB = { id: 2 };
  const base = { baselineFindings: baseline, latestFindings: [f('https://x.com/a', 'high')], reached: new Set(['https://x.com/a', 'https://x.com/b']) };
  assert.equal(pageScoreSection({ ...base, baselineRun: runA, latestRun: runA }), null, 'same audit');
  assert.equal(pageScoreSection({ ...base, baselineRun: null, latestRun: runB }), null);
  assert.equal(pageScoreSection({ ...base, baselineRun: runA, latestRun: runB, latestFindings: baseline }), null, 'nothing improved');
  const s = pageScoreSection({ ...base, baselineRun: runA, latestRun: runB });
  assert.deepEqual(s.table.rows[0], ['/a', '76', '88', { t: '▲ +12', tone: 'good' }]);
});
