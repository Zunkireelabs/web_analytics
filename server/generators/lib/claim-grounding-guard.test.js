import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findUngroundedClaims } from './claim-grounding-guard.js';

function draft(sections, groundingContext = '') {
  return { headline: 'Welcome', subheadline: '', sections, groundingContext };
}

describe('findUngroundedClaims', () => {
  test('flags a specific scale claim not present in the supporting data', () => {
    const content = draft([{ heading: 'Trusted', body: 'We have served 500+ clients across the region.' }], 'Nepal is a growing market for AI services.');
    const issues = findUngroundedClaims(content);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].patternId, 'ungrounded-claim');
    assert.match(issues[0].correction, /500/);
  });

  test('does NOT flag a scale claim whose real number is present in the supporting data', () => {
    const content = draft([{ heading: 'Trusted', body: 'We have served 500+ clients across the region.' }], 'Real data: this business has served 500 clients since 2018.');
    assert.equal(findUngroundedClaims(content).length, 0);
  });

  test('flags an invented price', () => {
    const content = draft([{ heading: 'Pricing', body: 'Plans start at just $49/month.' }], 'This business offers web design services in Kathmandu.');
    const issues = findUngroundedClaims(content);
    assert.equal(issues.length, 1);
    assert.match(issues[0].detail, /\$49/);
  });

  test('flags an invented percentage statistic', () => {
    const content = draft([{ heading: 'Results', body: 'Our clients see a 40% increase in leads.' }], 'This business offers marketing services.');
    const issues = findUngroundedClaims(content);
    assert.equal(issues.length, 1);
    assert.match(issues[0].detail, /40%/);
  });

  test('flags an unbacked superlative/authority phrase', () => {
    const content = draft([{ heading: 'Why Us', body: 'We are the industry-leading provider in the region.' }], 'This business offers AI development services.');
    const issues = findUngroundedClaims(content);
    assert.equal(issues.length, 1);
    assert.match(issues[0].detail, /industry-leading/);
  });

  test('does not flag a superlative phrase the supporting data itself actually states', () => {
    const content = draft([{ heading: 'Why Us', body: 'We are an award-winning provider.' }], 'Real data: this business is an award-winning provider, verified.');
    assert.equal(findUngroundedClaims(content).length, 0);
  });

  test('clean, non-claim-shaped prose passes with no issues', () => {
    const content = draft([{ heading: 'Why Us', body: 'We help you explore top destinations and apply to global universities.' }], 'This business helps students study abroad.');
    assert.equal(findUngroundedClaims(content).length, 0);
  });

  test('the same number/unit pair is only flagged once, not once per mention', () => {
    const content = draft([
      { heading: 'A', body: 'We serve 500+ clients.' },
      { heading: 'B', body: 'Join our 500+ clients today.' },
    ], '');
    assert.equal(findUngroundedClaims(content).length, 1);
  });

  test('no content or empty text never crashes and reports nothing', () => {
    assert.deepEqual(findUngroundedClaims(null), []);
    assert.deepEqual(findUngroundedClaims({}), []);
    assert.deepEqual(findUngroundedClaims(draft([])), []);
  });
});
