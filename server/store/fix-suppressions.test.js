import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMaterialRegression, isSuppressed, isSuppressionEnforcing,
  MIN_REGRESSION_CLICKS, MIN_REGRESSION_SHARE, DEFAULT_SUPPRESSION_DAYS,
} from './fix-suppressions.js';

// The pure rules only — the upsert itself is a DB fact, same split detect.js
// uses for its own thresholds.

describe('isMaterialRegression', () => {
  test('a real, large drop counts', () => {
    assert.equal(isMaterialRegression({ clicks: -20 }, { clicks: 50 }), true);
  });

  test('a 1-to-0 wobble does NOT count', () => {
    // The exact shape of a real false alarm this system sent: a query going
    // from 1 click to 0 reported as a high-priority issue. Suppressing a
    // generator from a page on that evidence would be the same mistake with
    // worse consequences, since it bans future work rather than just
    // sending an email.
    assert.equal(isMaterialRegression({ clicks: -1 }, { clicks: 1 }), false);
  });

  test('a drop below the absolute floor never counts, however total the loss', () => {
    // 4 of 4 clicks is 100% of the baseline and still below the floor.
    assert.equal(isMaterialRegression({ clicks: -4 }, { clicks: 4 }), false);
    assert.equal(MIN_REGRESSION_CLICKS, 5);
  });

  test('a big page\'s ordinary variance does not trip it', () => {
    // 10 clicks lost is past the floor, but it is 1% of a 1000-click page.
    assert.equal(isMaterialRegression({ clicks: -10 }, { clicks: 1000 }), false);
    assert.equal(MIN_REGRESSION_SHARE, 0.2);
  });

  test('both tests must pass, at exactly the boundary', () => {
    assert.equal(isMaterialRegression({ clicks: -5 }, { clicks: 25 }), true);
    assert.equal(isMaterialRegression({ clicks: -5 }, { clicks: 26 }), false);
  });

  test('an improvement or a flat result never counts', () => {
    assert.equal(isMaterialRegression({ clicks: 30 }, { clicks: 50 }), false);
    assert.equal(isMaterialRegression({ clicks: 0 }, { clicks: 50 }), false);
  });

  test('missing data is not a regression — "we don\'t know" must not read as harm', () => {
    assert.equal(isMaterialRegression(null, { clicks: 50 }), false);
    assert.equal(isMaterialRegression({ clicks: -20 }, null), false);
    assert.equal(isMaterialRegression({ clicks: -20 }, { clicks: 0 }), false);
  });
});

describe('isSuppressed', () => {
  const set = new Set(['page:/pricing:meta-title']);

  test('matches the suppressed page and generator', () => {
    assert.equal(isSuppressed(set, { scopeKey: '/pricing', generatorId: 'meta-title' }), true);
  });

  test('normalizes the page, so a live URL matches a stored path', () => {
    assert.equal(isSuppressed(set, { scopeKey: 'https://www.example.com/pricing/', generatorId: 'meta-title' }), true);
  });

  test('a DIFFERENT generator on the same page is untouched', () => {
    // The point of page-level suppression: one kind of fix is wrong here,
    // not every kind.
    assert.equal(isSuppressed(set, { scopeKey: '/pricing', generatorId: 'expand-content' }), false);
  });

  test('the same generator on a different page is untouched', () => {
    assert.equal(isSuppressed(set, { scopeKey: '/about', generatorId: 'meta-title' }), false);
  });

  test('an unkeyable or generator-less item is never suppressed', () => {
    assert.equal(isSuppressed(set, { scopeKey: '', generatorId: 'meta-title' }), false);
    assert.equal(isSuppressed(set, { scopeKey: '/pricing', generatorId: null }), false);
  });
});

describe('flag and window', () => {
  test('enforcement is off by default', () => {
    assert.equal(isSuppressionEnforcing({}), false);
    assert.equal(isSuppressionEnforcing({ FIX_SUPPRESSION_ENABLED: 'true' }), true);
  });

  test('the automatic window outlasts the measurement cycle that produced it', () => {
    // fix_impact measures ~31 days post-merge; a shorter suppression would
    // let the same fix return before its own verdict landed.
    assert.ok(DEFAULT_SUPPRESSION_DAYS > 31);
  });
});
