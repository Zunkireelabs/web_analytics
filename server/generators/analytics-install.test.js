import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// getSiteById is mocked so every test controls exactly what "the site's
// configured tracking ID" is, without touching a real database — same
// convention as blog-image.test.js/faq.test.js for this same store module.
let siteFixture;
let siteLookupThrows = null;
mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async (id) => {
      if (siteLookupThrows) throw siteLookupThrows;
      assert.equal(id, siteFixture?.id ?? id);
      return siteFixture;
    },
  },
});

const { generate, meta } = await import('./analytics-install.js');

beforeEach(() => { siteFixture = null; siteLookupThrows = null; });

describe('analytics-install generator', () => {
  test('meta.id matches the generatorId trust-compliance.js wires into recommendedAction', () => {
    assert.equal(meta.id, 'analytics-install');
  });

  test('rejects an unknown provider', async () => {
    await assert.rejects(() => generate({ params: { provider: 'tiktok-pixel' } }));
  });

  test('ships a placeholder-blocked draft when no real tracking ID is given anywhere', async () => {
    const { content } = await generate({ params: { provider: 'ga4', page: 'https://example.com/' } });
    assert.deepEqual(content.placeholderFields, ['trackingId']);
    assert.match(content.script, /NEEDS INPUT/);
  });

  test('drafts a real GA4 script when a valid measurement ID is given via params', async () => {
    const { content, summary } = await generate({ params: { provider: 'ga4', trackingId: 'G-ABC1234XYZ' } });
    assert.deepEqual(content.placeholderFields, []);
    assert.match(content.script, /G-ABC1234XYZ/);
    assert.doesNotMatch(summary, /needs real tracking ID/);
  });

  test('drafts a real Facebook Pixel script when a valid numeric ID is given via params', async () => {
    const { content } = await generate({ params: { provider: 'facebook-pixel', trackingId: '123456789012345' } });
    assert.deepEqual(content.placeholderFields, []);
    assert.match(content.script, /123456789012345/);
    assert.match(content.script, /fbevents\.js/);
  });

  test('falls back to a placeholder when the given ID does not match the provider\'s real ID shape', async () => {
    const { content } = await generate({ params: { provider: 'ga4', trackingId: 'not-a-real-id' } });
    assert.deepEqual(content.placeholderFields, ['trackingId']);
  });

  // ── The bug this file was written to catch: a stale recommendation's
  // frozen params carry no trackingId, but the site's OWN CONFIGURATION
  // already has one. Confirmed live on site 1: drafts #631/#632
  // (2026-08-31, params with no trackingId) failed 15 times with the
  // "unverified placeholder field" refusal while sites.ga4_measurement_id
  // and sites.facebook_pixel_id both already held valid IDs. ──
  describe('reading the site\'s own configured ID (2026-09-08 fix)', () => {
    test('a configured GA4 ID is used even when params carry none at all — the stale-recommendation case', async () => {
      siteFixture = { id: 1, ga4_measurement_id: 'G-2ZQRDS0D14', facebook_pixel_id: null };
      const { content, summary } = await generate({ siteId: 1, params: { provider: 'ga4', page: 'https://zunkireelabs.com/' } });
      assert.deepEqual(content.placeholderFields, [], 'the generator must NOT report this as missing');
      assert.match(content.script, /G-2ZQRDS0D14/, 'the generator must receive and use the real configured ID');
      assert.doesNotMatch(summary, /needs real tracking ID/);
      assert.doesNotMatch(content.script, /NEEDS INPUT/);
    });

    test('a configured Facebook Pixel ID is used the same way', async () => {
      siteFixture = { id: 1, ga4_measurement_id: null, facebook_pixel_id: '2104437347081359' };
      const { content } = await generate({ siteId: 1, params: { provider: 'facebook-pixel', page: 'https://zunkireelabs.com/' } });
      assert.deepEqual(content.placeholderFields, []);
      assert.match(content.script, /2104437347081359/);
    });

    test('the configured site ID wins over a stale/different value carried in params', async () => {
      siteFixture = { id: 1, ga4_measurement_id: 'G-CURRENTVALID', facebook_pixel_id: null };
      const { content } = await generate({ siteId: 1, params: { provider: 'ga4', trackingId: 'G-STALEFROZEN' } });
      assert.match(content.script, /G-CURRENTVALID/);
      assert.doesNotMatch(content.script, /G-STALEFROZEN/);
    });

    test('a malformed value stored on the site still falls through to the placeholder gate', async () => {
      siteFixture = { id: 1, ga4_measurement_id: 'not-a-real-id', facebook_pixel_id: null };
      const { content } = await generate({ siteId: 1, params: { provider: 'ga4' } });
      assert.deepEqual(content.placeholderFields, ['trackingId'], 'shape is still validated, not just presence');
    });

    test('a site lookup failure falls back to whatever params carry, never a hard error', async () => {
      siteLookupThrows = new Error('db unreachable');
      const { content } = await generate({ siteId: 1, params: { provider: 'ga4', trackingId: 'G-FROMPARAMS1' } });
      assert.match(content.script, /G-FROMPARAMS1/);
    });

    test('no siteId at all (a direct caller with only params) behaves exactly as before', async () => {
      const { content } = await generate({ params: { provider: 'ga4', trackingId: 'G-DIRECTCALL1' } });
      assert.match(content.script, /G-DIRECTCALL1/);
    });
  });
});
