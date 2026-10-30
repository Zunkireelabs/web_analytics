import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHex, deriveBrandTheme, isUsableAccent, contrastWithWhite, accentFromSite, ZUNKIREE_GREEN,
} from './brand-theme.js';

describe('deriveBrandTheme', () => {
  test('uses the client colour when it is a real colour', () => {
    const t = deriveBrandTheme('#c8a96e');
    assert.equal(t.accent, '#c8a96e');
    assert.equal(t.fellBack, false);
  });

  test('darkens a light accent until its text shade passes WCAG AA on white', () => {
    const t = deriveBrandTheme('#c8a96e');
    assert.ok(contrastWithWhite(parseHex(t.text)) >= 4.5, `text ${t.text} is too pale`);
    assert.notEqual(t.text, t.accent);
  });

  test('a dark accent keeps its own text colour', () => {
    const t = deriveBrandTheme('#1e4d2b');
    assert.equal(t.text, t.accent);
  });

  test('falls back to Zunkiree green when the colour is missing or not hex', () => {
    for (const bad of [null, undefined, '', 'gold', '#12', 'rgb(1,2,3)']) {
      const t = deriveBrandTheme(bad);
      assert.equal(t.accent, ZUNKIREE_GREEN, `input ${bad}`);
      assert.equal(t.fellBack, true);
    }
  });

  test('falls back when the colour is grey, near-white or near-black', () => {
    for (const bad of ['#888888', '#f5f5f5', '#fffdf5', '#050505']) {
      assert.equal(isUsableAccent(parseHex(bad)), false, bad);
      assert.equal(deriveBrandTheme(bad).accent, ZUNKIREE_GREEN, bad);
    }
  });

  test('accepts shorthand hex and a missing #', () => {
    assert.deepEqual(parseHex('c80'), [204, 136, 0]);
    assert.equal(deriveBrandTheme('c8a96e').accent, '#c8a96e');
  });

  test('tints are lighter than the accent', () => {
    const t = deriveBrandTheme('#c8a96e');
    const lum = (h) => parseHex(h).reduce((a, b) => a + b, 0);
    assert.ok(lum(t.soft) > lum(t.bar) && lum(t.bar) > lum(t.accent));
  });
});

describe('accentFromSite', () => {
  test('reads the Design Agent accent off url_file_map', () => {
    const site = { url_file_map: { siteRoot: { designProfile: { color: { accent: '#c8a96e' } } } } };
    assert.equal(accentFromSite(site), '#c8a96e');
  });

  test('handles a JSON string, and a site with no design profile', () => {
    assert.equal(accentFromSite({ url_file_map: JSON.stringify({ siteRoot: { designProfile: { color: { accent: '#123456' } } } }) }), '#123456');
    assert.equal(accentFromSite({ url_file_map: {} }), null);
    assert.equal(accentFromSite(null), null);
  });

  test('uses sites.brand_color first, then the primary button colour, same as the dashboard', () => {
    const map = { siteRoot: { designProfile: { color: { accent: 'text-blue-dark' }, components: { button: { primary: 'bg-[#0D1282]' } } } } };
    assert.equal(accentFromSite({ url_file_map: map }), '#0d1282');
    assert.equal(accentFromSite({ brand_color: '#c8a96e', url_file_map: map }), '#c8a96e');
  });
});
