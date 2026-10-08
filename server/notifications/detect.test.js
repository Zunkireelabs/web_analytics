import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isVisibilityDrop, isCitationGapWidened, summarizeCriticalFindings, AI_VISIBILITY_DROP_THRESHOLD, CITATION_GAP_WIDEN_THRESHOLD } from './detect.js';

// Pure threshold-check unit tests — the cooldown itself (hasRecentNotification)
// is a real DB query and intentionally not unit-tested here, same as the
// rest of this codebase's DB-touching code (no mocking framework is set up
// anywhere in this repo's tests); detectNotificationEvents' full end-to-end
// behavior (including the cooldown) is exercised in real deployments, not
// simulated in a unit test.

describe('isVisibilityDrop', () => {
  test('thresholds at exactly 15 points, matching the documented constant', () => {
    assert.equal(AI_VISIBILITY_DROP_THRESHOLD, 15);
  });

  test('true at exactly the threshold', () => {
    assert.equal(isVisibilityDrop(-15), true);
  });

  test('true when the drop exceeds the threshold', () => {
    assert.equal(isVisibilityDrop(-20), true);
  });

  test('false when the drop is smaller than the threshold', () => {
    assert.equal(isVisibilityDrop(-10), false);
  });

  test('false for a rise (positive delta)', () => {
    assert.equal(isVisibilityDrop(20), false);
  });

  test('false (not thrown) for null — "no valid prior run" case', () => {
    assert.equal(isVisibilityDrop(null), false);
  });
});

describe('isCitationGapWidened', () => {
  test('thresholds at exactly 10 points, matching the documented constant', () => {
    assert.equal(CITATION_GAP_WIDEN_THRESHOLD, 10);
  });

  test('true at exactly the threshold', () => {
    assert.equal(isCitationGapWidened(10), true);
  });

  test('true when the widening exceeds the threshold', () => {
    assert.equal(isCitationGapWidened(25), true);
  });

  test('false when the widening is smaller than the threshold', () => {
    assert.equal(isCitationGapWidened(5), false);
  });

  test('false when the gap narrowed (negative delta)', () => {
    assert.equal(isCitationGapWidened(-15), false);
  });

  test('false (not thrown) for null — pre-Phase-3 historical run with no real gap to compare', () => {
    assert.equal(isCitationGapWidened(null), false);
  });
});

describe('summarizeCriticalFindings', () => {
  test('names each page and counts distinct pages, not raw findings', () => {
    const r = summarizeCriticalFindings([
      { page: 'https://a.com/services/', text: 'Missing schema.' },
      { page: 'https://a.com/services/', text: 'Thin content.' },
      { page: 'https://a.com/about/', text: 'No FAQ.' },
    ]);
    assert.equal(r.pageCount, 2);
    assert.equal(r.issueCount, 3);
    assert.match(r.body, /\/services\/: 2 issues/);
    assert.match(r.body, /\/about\/: No FAQ\./);
  });

  test('caps the list and says how many more there are', () => {
    const f = Array.from({ length: 8 }, (_, i) => ({ page: `https://a.com/p${i}/`, text: 'x' }));
    const r = summarizeCriticalFindings(f);
    assert.match(r.body, /\+3 more/);
  });

  test('domain-level findings (no page) are listed by their own text', () => {
    const r = summarizeCriticalFindings([{ page: null, text: 'robots.txt blocks Googlebot.' }]);
    assert.equal(r.pageCount, 0);
    assert.match(r.body, /robots\.txt blocks Googlebot\./);
  });
});
