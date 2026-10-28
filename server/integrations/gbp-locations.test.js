import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_SCOPES, classifyGbpError, mapLocations, listBusinessLocations } from './gbp-locations.js';

const loc = (over = {}) => ({ name: 'locations/1', title: 'Zennly', storefrontAddress: { addressLines: ['Sanepa'], locality: 'Lalitpur' }, metadata: { mapsUri: 'https://maps.google.com/?cid=1', placeId: 'P1', hasVoiceOfMerchant: true }, ...over });

describe('scopes', () => {
  test('asks only for Business Profile access (plus who signed in), nothing from the main connection', () => {
    assert.deepEqual(BUSINESS_SCOPES, ['https://www.googleapis.com/auth/business.manage', 'openid', 'email']);
  });
});

describe('classifyGbpError', () => {
  test('quota 0 and disabled APIs mean "not available yet", not "you have no access"', () => {
    assert.equal(classifyGbpError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }), 'not_available');
    assert.equal(classifyGbpError(403, { error: { message: 'My Business Account Management API has not been used in project 123 before or it is disabled.' } }), 'not_available');
    assert.equal(classifyGbpError(403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } }), 'not_available');
  });
  test('an account without access is denied, anything else failed', () => {
    assert.equal(classifyGbpError(403, { error: { message: 'The caller does not have permission' } }), 'denied');
    assert.equal(classifyGbpError(401, {}), 'denied');
    assert.equal(classifyGbpError(500, {}), 'failed');
  });
});

describe('mapLocations', () => {
  test('keeps the name, one-line address, Maps link and verified flag', () => {
    assert.deepEqual(mapLocations({ locations: [loc()] }), [{ id: 'locations/1', name: 'Zennly', address: 'Sanepa, Lalitpur', mapsUrl: 'https://maps.google.com/?cid=1', placeId: 'P1', verified: true }]);
  });
  test('drops a location with no title or no Maps link, and tolerates junk', () => {
    assert.equal(mapLocations({ locations: [loc({ title: '' }), loc({ metadata: {} }), null] }).length, 0);
    assert.deepEqual(mapLocations(undefined), []);
  });
  test('a profile that is not verified says so', () => {
    assert.equal(mapLocations({ locations: [loc({ metadata: { mapsUri: 'https://maps.google.com/?cid=2' } })] })[0].verified, false);
  });
});

describe('listBusinessLocations', () => {
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  test('lists every account\'s locations, once each, with the bearer token', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      if (url.includes('accounts?')) return json({ accounts: [{ name: 'accounts/1' }, { name: 'accounts/2' }] });
      return json({ locations: [loc()] }); // both accounts return the same profile
    };
    const r = await listBusinessLocations('tok', { fetchImpl });
    assert.equal(r.length, 1);
    assert.ok(calls.every((c) => c.auth === 'Bearer tok'));
    assert.equal(calls.length, 3);
  });
  test('a Google refusal carries a classified reason, never an empty list', async () => {
    const fetchImpl = async () => json({ error: { status: 'RESOURCE_EXHAUSTED' } }, false, 429);
    await assert.rejects(listBusinessLocations('tok', { fetchImpl }), (e) => e.gbp === 'not_available');
  });
  test('an account with no profiles gives an honest empty list', async () => {
    const fetchImpl = async (url) => (url.includes('accounts?') ? json({}) : json({}));
    assert.deepEqual(await listBusinessLocations('tok', { fetchImpl }), []);
  });
});
