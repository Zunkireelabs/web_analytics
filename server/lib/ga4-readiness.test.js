import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ga4Readiness, GA4_STATE } from './ga4-readiness.js';

test('property connected but no measurement ID is NOT "ready" (the Superrank/Zennly/Mobilise case)', () => {
  const r = ga4Readiness({ ga4_property_id: '561094281', ga4_measurement_id: null });
  assert.equal(r.state, GA4_STATE.REPORTING_CONNECTED);
  assert.equal(r.measurementIdKnown, false);
  assert.match(r.needs, /measurement ID/);
});
test('a property ID typed into the measurement field does not count as a measurement ID', () => {
  assert.equal(ga4Readiness({ ga4_property_id: '561094281', ga4_measurement_id: '561094281' }).state, GA4_STATE.REPORTING_CONNECTED);
});
test('nothing connected', () => assert.equal(ga4Readiness({}).state, GA4_STATE.NOT_CONNECTED));
test('measurement ID known, nothing installed yet -> installation pending', () => {
  assert.equal(ga4Readiness({ ga4_property_id: '1', ga4_measurement_id: 'G-ABCD1234' }).state, GA4_STATE.INSTALLATION_PENDING);
  assert.equal(ga4Readiness({ ga4_property_id: '1', ga4_measurement_id: 'G-ABCD1234' }, 'still-present').state, GA4_STATE.INSTALLATION_PENDING, 'a failed check is not "installed"');
});
test('merged but unchecked -> installed, not verified', () => {
  for (const o of ['pending', 'awaiting-deployment', 'unreachable']) assert.equal(ga4Readiness({ ga4_property_id: '1', ga4_measurement_id: 'G-ABCD1234' }, o).state, GA4_STATE.INSTALLED_NOT_VERIFIED);
});
test('only a passed live check is "verified"', () => {
  assert.equal(ga4Readiness({ ga4_property_id: '1', ga4_measurement_id: 'G-ABCD1234' }, 'verified-fixed').state, GA4_STATE.INSTALLATION_VERIFIED);
  assert.equal(ga4Readiness({ ga4_property_id: '1', ga4_measurement_id: 'G-ABCD1234' }, 'unverifiable').state, GA4_STATE.INSTALLATION_PENDING);
});
