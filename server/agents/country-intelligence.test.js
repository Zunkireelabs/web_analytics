import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Same DATABASE_URL placeholder workaround as growth-queries.test.js/
// geo-audit.test.js — this file's import chain reaches server/db.js, which
// fails fast at import time if DATABASE_URL is unset. Nothing exercised
// below issues a real query; only the exported pure function is tested.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { topGainerAboveThreshold } = await import('./country-intelligence.js');

// Real report: a "Generate Landing Page" recommendation fired off a single
// market going from 0 to 1 sessions ("India grew from 0 to 1 sessions this
// period") — generating a landing page is a real, costly content-generation
// action and shouldn't be triggered by one visitor. The bug was
// growingMarkets[0]/growingCities[0] having no volume floor at all: the
// single largest delta among gainers wins even when that delta is a lone
// first-ever session.
describe('topGainerAboveThreshold', () => {
  test('a market with only 1 real session is not recommended, even as the single biggest gainer', () => {
    const gainers = [{ country: 'India', prior: 0, recent: 1, delta: 1 }];
    assert.equal(topGainerAboveThreshold(gainers), null);
  });

  test('a market with real volume (>= the threshold) is recommended', () => {
    const gainers = [{ country: 'Germany', prior: 20, recent: 35, delta: 15 }];
    assert.equal(topGainerAboveThreshold(gainers).country, 'Germany');
  });

  test('skips past a noisy top-delta entry to a smaller but real one further down the list', () => {
    const gainers = [
      { country: 'India', prior: 0, recent: 1, delta: 1 },
      { country: 'Germany', prior: 20, recent: 25, delta: 5 },
    ];
    assert.equal(topGainerAboveThreshold(gainers).country, 'Germany');
  });

  test('no gainers clear the floor -> null, not a guess', () => {
    const gainers = [{ country: 'India', prior: 0, recent: 1, delta: 1 }, { country: 'Nepal', prior: 2, recent: 3, delta: 1 }];
    assert.equal(topGainerAboveThreshold(gainers), null);
  });

  test('empty gainers list -> null', () => {
    assert.equal(topGainerAboveThreshold([]), null);
  });

  test('custom threshold overrides the default', () => {
    const gainers = [{ country: 'India', prior: 0, recent: 1, delta: 1 }];
    assert.equal(topGainerAboveThreshold(gainers, 1).country, 'India');
  });
});
