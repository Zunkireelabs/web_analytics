import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let authUsed;
let streams;
mock.module('googleapis', {
  namedExports: { google: { analyticsadmin: ({ auth }) => { authUsed = auth; return { properties: { dataStreams: { list: async () => ({ data: { dataStreams: streams } }) } } }; } } },
});
mock.module(resolve('../auth/google.js'), {
  namedExports: { getProjectScopedGoogleAuth: async (site) => (site.id === 8874 ? 'PROJECT-OWN-ACCOUNT' : 'SHARED-PLATFORM-ACCOUNT') },
});
mock.module(resolve('../db.js'), { namedExports: { updateSiteAnalyticsIds: async () => {} } });
const { discoverMeasurementId } = await import('./ga4-measurement-id.js');

beforeEach(() => { authUsed = null; streams = [{ type: 'WEB_DATA_STREAM', displayName: 'web', webStreamData: { measurementId: 'G-HQZ0NXDXKX', defaultUri: 'https://www.mobilise.agency' } }]; });

describe('GA4 tag ID discovery uses the project\'s own Google connection', () => {
  test('a project with its own connection is read with that account, and its tag ID is found', async () => {
    const r = await discoverMeasurementId({ id: 8874, ga4_property_id: '419590152', ga4_measurement_id: null, website_domain: 'mobilise.agency' });
    assert.equal(authUsed, 'PROJECT-OWN-ACCOUNT');
    assert.deepEqual([r.status, r.measurementId], ['found', 'G-HQZ0NXDXKX']);
  });
  test('a project with none falls back to the shared platform account, as before', async () => {
    await discoverMeasurementId({ id: 1, ga4_property_id: '296921613', ga4_measurement_id: null, website_domain: 'mobilise.agency' });
    assert.equal(authUsed, 'SHARED-PLATFORM-ACCOUNT');
  });
});
