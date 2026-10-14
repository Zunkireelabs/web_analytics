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

  // The false-positive risk raised for blog-outline.js: general industry
  // commentary has the same digit+unit shape as a business-specific claim
  // and is allowed by that generator's own prompt to be written from
  // general knowledge — but only when it's actually presented as general
  // knowledge (attributed/hedged), not as a bare unqualified fact. An
  // unattributed "general-sounding" number is just as fabricatable as a
  // business-specific one and must still be caught.
  test('does NOT flag a general industry statistic that is explicitly attributed', () => {
    const content = draft([{ heading: 'Industry Trends', body: '70% of businesses now use some form of AI automation, according to recent industry reports.' }], 'This business builds AI systems.');
    assert.equal(findUngroundedClaims(content).length, 0);
  });

  test('DOES flag the same digits when framed as a claim about the author\'s own business', () => {
    const content = draft([{ heading: 'Our Track Record', body: 'We have helped 70% of our clients cut costs significantly.' }], 'This business builds AI systems.');
    const issues = findUngroundedClaims(content);
    assert.equal(issues.length, 1);
    assert.match(issues[0].detail, /70%/);
  });

  test('DOES flag a general-sounding statistic with NO attribution and no business framing — bare invented numbers are not automatically safe', () => {
    const content = draft([{ heading: 'Market Size', body: 'Over 500,000 companies worldwide have adopted similar automation platforms.' }], 'This business builds AI systems.');
    const issues = findUngroundedClaims(content);
    assert.equal(issues.length, 1);
    assert.match(issues[0].correction, /attribut/i);
  });

  test('does NOT flag the same unattributed-shape claim once it is actually backed by real groundingContext', () => {
    const content = draft([{ heading: 'Market Size', body: 'Over 500,000 companies worldwide have adopted similar automation platforms.' }], 'Real data: 500,000 companies worldwide use this category of platform.');
    assert.equal(findUngroundedClaims(content).length, 0);
  });

  test('a comma-formatted number in groundingContext still matches a comma-formatted claim (both normalized the same way)', () => {
    const content = draft([{ heading: 'Our Scale', body: 'We have served 1,200,000 customers to date.' }], 'Real data: this business has served 1,200,000 customers to date.');
    assert.equal(findUngroundedClaims(content).length, 0);
  });

  test('no content or empty text never crashes and reports nothing', () => {
    assert.deepEqual(findUngroundedClaims(null), []);
    assert.deepEqual(findUngroundedClaims({}), []);
    assert.deepEqual(findUngroundedClaims(draft([])), []);
  });
});
