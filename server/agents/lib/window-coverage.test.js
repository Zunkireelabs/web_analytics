import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessWindows, windowCoverage, computeShareShifts, splitShareShifts, isUnattributedDim, clipWindowToLag,
} from './window-coverage.js';

const range = (start, end) => {
  const out = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

const RECENT = { start: '2026-09-04', end: '2026-10-01' };
const PRIOR = { start: '2026-08-07', end: '2026-09-03' };

describe('assessWindows', () => {
  test('both windows fully covered -> ok', () => {
    const w = assessWindows(RECENT, PRIOR, range('2026-08-07', '2026-10-01'), { lagDays: 0, today: '2026-10-01' });
    assert.equal(w.ok, true);
  });

  test('site 8862 shape: GA4 starts 08-31, the prior window has 4 of 28 days -> abstain', () => {
    const w = assessWindows(RECENT, PRIOR, range('2026-08-31', '2026-10-01'), { lagDays: 0, today: '2026-10-01' });
    assert.equal(w.ok, false);
    assert.match(w.reason, /prior window has data on only 4 of 28/);
  });

  test('site 8864 shape: GA4 starts inside the recent window, prior empty -> abstain', () => {
    const w = assessWindows(RECENT, PRIOR, range('2026-09-10', '2026-10-01'), { lagDays: 0, today: '2026-10-01' });
    assert.equal(w.ok, false);
  });

  test('GSC lag: the recent window is clipped to today-3 and the prior window trimmed by the same days', () => {
    const w = assessWindows(RECENT, PRIOR, range('2026-08-07', '2026-09-28'), { lagDays: 3, today: '2026-10-01' });
    assert.equal(w.ok, true);
    assert.equal(w.recent.end, '2026-09-28');
    assert.equal(w.prior.end, '2026-08-31');
    assert.equal(w.coverage.recent.days, w.coverage.prior.days);
  });

  test('without the lag clip those same GSC dates would have failed the 90% bar', () => {
    const w = assessWindows(RECENT, PRIOR, range('2026-08-07', '2026-09-28'), { lagDays: 0, today: '2026-10-01' });
    assert.equal(w.ok, false);
  });

  test('unknown coverage (null) abstains', () => {
    assert.equal(assessWindows(RECENT, PRIOR, null).ok, false);
  });

  test('windowCoverage counts only days with rows', () => {
    const c = windowCoverage({ start: '2026-09-01', end: '2026-09-10' }, ['2026-09-01', '2026-09-02']);
    assert.deepEqual([c.days, c.covered], [10, 2]);
  });

  test('clipWindowToLag returns null when nothing final is left', () => {
    assert.equal(clipWindowToLag({ start: '2026-09-30', end: '2026-10-01' }, 3, '2026-10-01'), null);
  });
});

describe('computeShareShifts', () => {
  test('a whole-site surge with an unchanged mix produces no share movers', () => {
    const prior = [{ dim_value: 'mobile', sessions: 100 }, { dim_value: 'desktop', sessions: 100 }];
    const recent = [{ dim_value: 'mobile', sessions: 1000 }, { dim_value: 'desktop', sessions: 1000 }];
    const { gainers, droppers } = splitShareShifts(computeShareShifts(recent, prior));
    assert.deepEqual([gainers, droppers], [[], []]);
  });

  test('a real mix change is reported by share, in percentage points', () => {
    const prior = [{ dim_value: 'mobile', sessions: 50 }, { dim_value: 'desktop', sessions: 50 }];
    const recent = [{ dim_value: 'mobile', sessions: 700 }, { dim_value: 'desktop', sessions: 300 }];
    const { gainers, droppers } = splitShareShifts(computeShareShifts(recent, prior));
    assert.equal(gainers[0].key, 'mobile');
    assert.equal(gainers[0].shareDelta, 20);
    assert.equal(droppers[0].key, 'desktop');
  });

  test('(not set)/(other) are dropped from rows and totals', () => {
    const prior = [{ dim_value: 'Nepal', sessions: 10 }, { dim_value: '(not set)', sessions: 990 }];
    const recent = [{ dim_value: 'Nepal', sessions: 10 }, { dim_value: '(other)', sessions: 5 }];
    const shifts = computeShareShifts(recent, prior);
    assert.deepEqual(shifts.map((s) => s.key), ['Nepal']);
    assert.equal(shifts[0].shareDelta, 0);
    assert.equal(isUnattributedDim('(not set)'), true);
  });

  test('an empty window yields no shifts rather than a divide-by-zero', () => {
    assert.deepEqual(computeShareShifts([{ dim_value: 'a', sessions: 5 }], []), []);
  });
});
