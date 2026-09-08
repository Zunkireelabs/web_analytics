import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalyticsIdsRequest } from './clients.js';

// Before this route existed, sites.ga4_measurement_id/facebook_pixel_id were
// readable (generators/analytics-install.js reads them live at draft time)
// but writable nowhere except a hand-written SQL UPDATE — same class of gap
// design_agent_enabled had. These tests cover the one piece of real logic
// the route adds: rejecting a value that would ship a tracking script
// collecting nothing, using the exact same shape generators/analytics-install.js
// itself checks at draft time.

describe('validateAnalyticsIdsRequest', () => {
  test('accepts a well-formed GA4 measurement ID', () => {
    assert.equal(validateAnalyticsIdsRequest({ ga4MeasurementId: 'G-ABC123XYZ0' }), null);
  });

  test('accepts a well-formed Meta Pixel ID', () => {
    assert.equal(validateAnalyticsIdsRequest({ facebookPixelId: '123456789012345' }), null);
  });

  test('accepts both at once', () => {
    assert.equal(validateAnalyticsIdsRequest({ ga4MeasurementId: 'G-ABC123XYZ0', facebookPixelId: '123456789012345' }), null);
  });

  test('accepts neither being present — a partial PATCH', () => {
    assert.equal(validateAnalyticsIdsRequest({}), null);
  });

  test('rejects a GA4 ID missing the required "G-" prefix', () => {
    const err = validateAnalyticsIdsRequest({ ga4MeasurementId: 'ABC123XYZ0' });
    assert.match(err, /GA4 Measurement ID/);
  });

  test('rejects a Meta Pixel ID that is not purely numeric', () => {
    const err = validateAnalyticsIdsRequest({ facebookPixelId: 'GA-123456789012345' });
    assert.match(err, /Meta Pixel ID/);
  });

  test('rejects a Meta Pixel ID that is too short to be real', () => {
    const err = validateAnalyticsIdsRequest({ facebookPixelId: '12345' });
    assert.match(err, /Meta Pixel ID/);
  });

  test('an empty string is never validated — clearing a field is always allowed', () => {
    assert.equal(validateAnalyticsIdsRequest({ ga4MeasurementId: '', facebookPixelId: '' }), null);
  });
});
