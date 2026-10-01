import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { filterMovers } = await import('./read.js');

const row = (recent, prior, extra = {}) => ({ query: 'q', recent, prior, delta: recent - prior, in_recent: true, in_prior: true, ...extra });

describe('filterMovers', () => {
  test('default options keep the legacy behavior (only zero-delta rows are dropped)', () => {
    assert.equal(filterMovers([row(0, 2), row(3, 3)]).length, 1);
  });

  test('a "2 to 0" wobble is not a mover once a click floor applies', () => {
    assert.equal(filterMovers([row(0, 2)], { minClicks: 5 }).length, 0);
    assert.equal(filterMovers([row(0, 9)], { minClicks: 5 }).length, 1);
  });

  test('significance test: 10 -> 6 is within noise, 40 -> 10 is not', () => {
    assert.equal(filterMovers([row(6, 10)], { significantZ: 2 }).length, 0);
    assert.equal(filterMovers([row(10, 40)], { significantZ: 2 }).length, 1);
  });

  test('requireBoth: a query absent from one window (fell out of the top-N / anonymised) is not "dropped to 0"', () => {
    const absent = row(0, 30, { in_recent: false });
    assert.equal(filterMovers([absent], { requireBoth: true }).length, 0);
    assert.equal(filterMovers([row(2, 30)], { requireBoth: true }).length, 1);
  });
});
