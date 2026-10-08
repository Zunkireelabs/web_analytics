import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareBodyMeasures, tailwindFontSizePx } from './body-measure.js';

const measure = (over = {}) => ({
  found: true, regionWidth: 760,
  h2: { fontSize: 28, borderBottom: 0 }, p: { fontSize: 18, lineHeightRatio: 1.7 },
  paragraphGap: 24, lineChars: 70, horizontalOverflow: false, ...over,
});

describe('tailwindFontSizePx', () => {
  test('responsive prefixes apply cumulatively; the widest applicable wins', () => {
    assert.equal(tailwindFontSizePx('text-3xl md:text-4xl lg:text-5xl', 1440), 48);
    assert.equal(tailwindFontSizePx('text-3xl md:text-4xl lg:text-5xl', 800), 36);
    assert.equal(tailwindFontSizePx('text-3xl md:text-4xl lg:text-5xl', 390), 30);
  });
  test('arbitrary values and non-size classes', () => {
    assert.equal(tailwindFontSizePx('text-[28px] font-bold', 1440), 28);
    assert.equal(tailwindFontSizePx('font-bold text-gray-900', 1440), null);
  });
  test('state variants (hover:, dark:) do not apply to a plain render', () => {
    assert.equal(tailwindFontSizePx('text-xl hover:text-5xl dark:text-4xl', 1440), 20);
  });
  test('empty input is null, not a throw', () => {
    assert.equal(tailwindFontSizePx('', 1440), null);
    assert.equal(tailwindFontSizePx(null), null);
  });
});

describe('compareBodyMeasures', () => {
  test('two honest pages of one site do not trip it', () => {
    assert.deepEqual(compareBodyMeasures(measure(), measure({ h2: { fontSize: 29, borderBottom: 0 }, paragraphGap: 26 })), []);
  });
  test('the reported bug — 30-48px headings against 28px — is far outside', () => {
    const out = compareBodyMeasures(measure(), measure({ h2: { fontSize: 48, borderBottom: 0 } }));
    assert.deepEqual(out.map((d) => d.kind), ['heading-scale']);
    assert.equal(out[0].expected, 28);
    assert.equal(out[0].actual, 48);
  });
  test('body size, line height, gaps and line length each report on their own', () => {
    const out = compareBodyMeasures(measure(), measure({ p: { fontSize: 20, lineHeightRatio: 1.3 }, paragraphGap: 8, lineChars: 40 }));
    assert.deepEqual(out.map((d) => d.kind).sort(), ['body-size', 'line-height', 'line-length', 'paragraph-gap']);
  });
  test('a rule under headings that the reference has and the draft lacks breaks the flow', () => {
    const out = compareBodyMeasures(measure({ h2: { fontSize: 28, borderBottom: 1 } }), measure());
    assert.deepEqual(out.map((d) => d.kind), ['heading-rule']);
  });
  test('overflow only counts when the reference did not already have it', () => {
    assert.deepEqual(compareBodyMeasures(measure(), measure({ horizontalOverflow: true })).map((d) => d.kind), ['horizontal-overflow']);
    assert.deepEqual(compareBodyMeasures(measure({ horizontalOverflow: true }), measure({ horizontalOverflow: true })), []);
  });
  test('a missing measurement compares as nothing, never as a deviation', () => {
    assert.deepEqual(compareBodyMeasures({ found: false }, measure()), []);
    assert.deepEqual(compareBodyMeasures(measure(), { found: false }), []);
  });
  test('the viewport is recorded on every deviation', () => {
    assert.equal(compareBodyMeasures(measure(), measure({ h2: { fontSize: 48, borderBottom: 0 } }), { name: 'mobile' })[0].viewport, 'mobile');
  });
});
