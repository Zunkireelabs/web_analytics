import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSiteLocations } from './site-locations.js';

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
