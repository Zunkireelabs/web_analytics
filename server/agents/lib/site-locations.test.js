import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSiteLocations, targetMarketNames, probeCountry } from './site-locations.js';

describe('resolveSiteLocations', () => {
  test('a site with no target_scope/country_code resolves to the single global default', () => {
    assert.deepEqual(resolveSiteLocations({}), [{ locationCode: 2840, languageCode: 'en' }]);
  });

  test("'local' scope resolves to only the site's own market", () => {
    const site = { target_scope: 'local', country_code: 2826, language_code: 'en' };
    assert.deepEqual(resolveSiteLocations(site), [{ locationCode: 2826, languageCode: 'en' }]);
  });

  test("'hybrid' scope resolves to the site's own market plus the global default", () => {
    const site = { target_scope: 'hybrid', country_code: 2524, language_code: 'en' };
    assert.deepEqual(resolveSiteLocations(site), [
      { locationCode: 2524, languageCode: 'en' },
      { locationCode: 2840, languageCode: 'en' },
    ]);
  });

  test('an explicit target_markets list takes priority over target_scope, of any length', () => {
    const site = {
      target_scope: 'hybrid', // would otherwise mean [country_code, global default]
      country_code: 2524,
      language_code: 'en',
      target_markets: [
        { locationCode: 2840, languageCode: 'en' },
        { locationCode: 2276, languageCode: 'de' },
        { locationCode: 2528, languageCode: 'nl' },
      ],
    };
    assert.deepEqual(resolveSiteLocations(site), [
      { locationCode: 2840, languageCode: 'en' },
      { locationCode: 2276, languageCode: 'de' },
      { locationCode: 2528, languageCode: 'nl' },
    ]);
  });

  test('a target_markets entry with no languageCode falls back to the global default language', () => {
    const site = { target_markets: [{ locationCode: 2276 }] };
    assert.deepEqual(resolveSiteLocations(site), [{ locationCode: 2276, languageCode: 'en' }]);
  });

  test('an empty target_markets array is ignored, falling back to target_scope', () => {
    const site = { target_scope: 'local', country_code: 2826, language_code: 'en', target_markets: [] };
    assert.deepEqual(resolveSiteLocations(site), [{ locationCode: 2826, languageCode: 'en' }]);
  });
});

describe('targetMarketNames', () => {
  test('lists every configured market by readable name, de-duplicated', () => {
    const site = { target_markets: [{ locationCode: 2840 }, { locationCode: 2524 }, { locationCode: 2840 }] };
    assert.deepEqual(targetMarketNames(site), ['the United States', 'Nepal']);
  });

  test('a local-only site yields no market text, so its prompts stay local', () => {
    assert.deepEqual(targetMarketNames({ target_scope: 'local', country_code: 2826 }), []);
    assert.deepEqual(targetMarketNames({}), []);
  });
});

// The four live sites' real market columns (read from production 2026-11-18), so these tests use the shapes the agent
// actually receives, not hand-written ones.
const LIVE = {
  chayce: { id: 8864, country_code: 2826, language_code: 'en', target_scope: 'local', target_markets: null },
  admizz: { id: 8862, country_code: 2524, language_code: 'en', target_scope: 'hybrid', target_markets: null },
  mobilise: { id: 8868, country_code: null, language_code: 'en', target_scope: 'global', target_markets: null },
  zunkiree: {
    id: 1, country_code: 2524, language_code: 'en', target_scope: 'global',
    target_markets: [2840, 2826, 2356, 2036, 2124, 2524, 2756, 2528, 2276].map((locationCode) => ({ languageCode: 'en', locationCode })),
  },
};

describe('probeCountry', () => {
  test('a local UK business is asked from the United Kingdom', () => {
    assert.deepEqual(probeCountry(LIVE.chayce), { iso: 'GB', name: 'the United Kingdom' });
  });

  test('hybrid, global and multi-market sites get no location, as before', () => {
    assert.equal(probeCountry(LIVE.admizz), null);
    assert.equal(probeCountry(LIVE.mobilise), null);
    assert.equal(probeCountry(LIVE.zunkiree), null);
  });

  test('a local site with no country_code does not fall back to the US default', () => {
    assert.equal(probeCountry({ target_scope: 'local', country_code: null }), null);
  });

  test('an explicit one-market list counts as one country', () => {
    assert.deepEqual(probeCountry({ target_markets: [{ locationCode: 2036, languageCode: 'en' }] }), { iso: 'AU', name: 'Australia' });
  });

  test('a market with no ISO mapping sends no location rather than a wrong one', () => {
    assert.equal(probeCountry({ target_scope: 'local', country_code: 9999 }), null);
  });
});
