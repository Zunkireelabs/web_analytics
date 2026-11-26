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
  test('H3 is held to the client\'s own article like H2, at desktop and at mobile', () => {
    const ref = measure({ h3: { fontSize: 20, borderBottom: 0 } });
    for (const vp of [{ name: 'desktop' }, { name: 'mobile' }]) {
      const out = compareBodyMeasures(ref, measure({ h3: { fontSize: 32, borderBottom: 0 } }), vp);
      assert.deepEqual(out.map((d) => [d.kind, d.viewport, d.expected, d.actual]), [['subheading-scale', vp.name, 20, 32]]);
    }
  });
  test('H3 within tolerance passes; a draft or reference with no H3 is not compared (nothing to measure against)', () => {
    assert.deepEqual(compareBodyMeasures(measure({ h3: { fontSize: 20 } }), measure({ h3: { fontSize: 21 } })), []);
    assert.deepEqual(compareBodyMeasures(measure({ h3: { fontSize: 20 } }), measure()), []);
    assert.deepEqual(compareBodyMeasures(measure(), measure({ h3: { fontSize: 40 } })), []);
  });
  const RGB1 = 'rgb(35, 40, 58)'; const RGB2 = 'rgb(85, 85, 85)';
  const styled = (over = {}) => measure({
    p: { fontSize: 18, lineHeightRatio: 1.7, color: RGB2, fontFamily: 'poppins' },
    h2: { fontSize: 28, borderBottom: 0, marginTop: 64, color: RGB1, fontWeight: '500', fontFamily: 'playfair display' },
    h3: { fontSize: 20, color: RGB1, fontWeight: '500', fontFamily: 'playfair display' },
    link: { color: 'rgb(180, 30, 60)', underline: true }, ...over,
  });
  test('an identical look passes at both viewports (nothing new is flagged)', () => {
    for (const vp of [{ name: 'desktop' }, { name: 'mobile' }]) assert.deepEqual(compareBodyMeasures(styled(), styled(), vp), []);
  });
  test('body colour and typeface are the client\'s or they are not: any difference is reported, with both values', () => {
    const out = compareBodyMeasures(styled(), styled({ p: { fontSize: 18, lineHeightRatio: 1.7, color: RGB1, fontFamily: 'arial' } }));
    assert.deepEqual(out.map((d) => [d.kind, d.expected, d.actual]), [['body-color', RGB2, RGB1], ['body-font', 'poppins', 'arial']]);
  });
  test('heading colour, weight and typeface (H2 and H3) are each held to the client\'s own', () => {
    const out = compareBodyMeasures(styled(), styled({
      h2: { fontSize: 28, borderBottom: 0, marginTop: 64, color: RGB2, fontWeight: '700', fontFamily: 'arial' },
      h3: { fontSize: 20, color: RGB2, fontWeight: '400', fontFamily: 'arial' },
    }));
    assert.deepEqual(out.map((d) => d.kind).sort(), ['heading-color', 'heading-font', 'heading-weight', 'subheading-color', 'subheading-font', 'subheading-weight']);
  });
  test('heading spacing: the Zennly shape (64px above each H2 on the live article, none on the draft) is caught; a few px of difference is not', () => {
    const out = compareBodyMeasures(styled(), styled({ h2: { fontSize: 28, borderBottom: 0, marginTop: 0, color: RGB1, fontWeight: '500', fontFamily: 'playfair display' } }));
    assert.deepEqual(out.map((d) => [d.kind, d.expected, d.actual]), [['heading-spacing', 64, 0]]);
    assert.deepEqual(compareBodyMeasures(styled(), styled({ h2: { fontSize: 28, borderBottom: 0, marginTop: 60, color: RGB1, fontWeight: '500', fontFamily: 'playfair display' } })), []);
  });
  test('a reference with no real spacing above its headings never demands any', () => {
    const ref = styled({ h2: { fontSize: 28, borderBottom: 0, marginTop: 4, color: RGB1, fontWeight: '500', fontFamily: 'playfair display' } });
    assert.deepEqual(compareBodyMeasures(ref, styled({ h2: { fontSize: 28, borderBottom: 0, marginTop: 40, color: RGB1, fontWeight: '500', fontFamily: 'playfair display' } })), []);
  });
  test('link colour and underline are compared when both pages have a link; a missing link is not a difference', () => {
    const out = compareBodyMeasures(styled(), styled({ link: { color: 'rgb(0, 0, 255)', underline: false } }));
    assert.deepEqual(out.map((d) => d.kind), ['link-color', 'link-underline']);
    assert.deepEqual(compareBodyMeasures(styled(), styled({ link: null })), []);
  });
  test('older measurements with no colour fields still compare as before (nothing is demanded of a missing value)', () => {
    assert.deepEqual(compareBodyMeasures(measure(), measure()), []);
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
