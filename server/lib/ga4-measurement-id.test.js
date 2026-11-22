import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { discoverMeasurementId, ensureMeasurementId, needsInputMessage, isMeasurementId, isPropertyId } from './ga4-measurement-id.js';

const adminWith = (streams, { fail } = {}) => ({
  properties: { dataStreams: { list: async () => { if (fail) throw fail; return { data: { dataStreams: streams } }; } } },
});
const web = (id, uri) => ({ type: 'WEB_DATA_STREAM', displayName: uri, webStreamData: { measurementId: id, defaultUri: uri } });
const site = (over = {}) => ({ id: 7, website_domain: 'superrank.si', ga4_property_id: '561094281', ga4_measurement_id: null, ...over });

describe('GA4 property id vs measurement id', () => {
  test('a property id is never accepted as a measurement id, and vice versa', () => {
    assert.equal(isMeasurementId('561094281'), false);
    assert.equal(isMeasurementId('G-ABCD1234'), true);
    assert.equal(isPropertyId('G-ABCD1234'), false);
    assert.equal(isPropertyId('561094281'), true);
  });
  test('a property id stored in the measurement id field is ignored and discovery runs', async () => {
    const r = await discoverMeasurementId(site({ ga4_measurement_id: '561094281' }), { admin: adminWith([web('G-REAL00001', 'https://superrank.si')]) });
    assert.equal(r.status, 'found');
    assert.equal(r.measurementId, 'G-REAL00001');
  });
});

describe('discoverMeasurementId', () => {
  test('already stored: nothing is called', async () => {
    const r = await discoverMeasurementId(site({ ga4_measurement_id: 'G-STORED001' }), { admin: { properties: { dataStreams: { list: () => { throw new Error('no call expected'); } } } } });
    assert.deepEqual(r, { status: 'present', measurementId: 'G-STORED001' });
  });
  test('no connected property → no-property', async () => {
    assert.equal((await discoverMeasurementId(site({ ga4_property_id: null }), { admin: adminWith([]) })).status, 'no-property');
  });
  test('the stream for the site\'s own domain is used (www and scheme ignored)', async () => {
    const r = await discoverMeasurementId(site(), { admin: adminWith([web('G-OTHER0001', 'https://other.com'), web('G-MINE00001', 'https://www.superrank.si/')]) });
    assert.equal(r.status, 'found');
    assert.equal(r.measurementId, 'G-MINE00001');
  });
  test('a lone stream for ANOTHER domain is never borrowed', async () => {
    const r = await discoverMeasurementId(site(), { admin: adminWith([web('G-OTHER0001', 'https://other.com')]) });
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.measurementId, undefined);
  });
  test('two different streams for the same domain are ambiguous, not guessed', async () => {
    const r = await discoverMeasurementId(site(), { admin: adminWith([web('G-AAAA00001', 'https://superrank.si'), web('G-BBBB00001', 'https://superrank.si')]) });
    assert.equal(r.status, 'ambiguous');
  });
  test('no web stream (only an app stream) → no-web-stream', async () => {
    const r = await discoverMeasurementId(site(), { admin: adminWith([{ type: 'ANDROID_APP_DATA_STREAM' }]) });
    assert.equal(r.status, 'no-web-stream');
  });
  test('permission denied vs not found vs temporary failure are told apart', async () => {
    assert.equal((await discoverMeasurementId(site(), { admin: adminWith([], { fail: Object.assign(new Error('x'), { code: 403 }) }) })).status, 'permission-denied');
    assert.equal((await discoverMeasurementId(site(), { admin: adminWith([], { fail: Object.assign(new Error('x'), { code: 404 }) }) })).status, 'no-property');
    assert.equal((await discoverMeasurementId(site(), { admin: adminWith([], { fail: Object.assign(new Error('x'), { code: 503 }) }) })).status, 'unavailable');
    assert.equal((await discoverMeasurementId(site(), { admin: adminWith([], { fail: new Error('socket hang up') }) })).status, 'unavailable');
  });
});

describe('ensureMeasurementId', () => {
  test('saves what it found against THIS site only', async () => {
    const saved = [];
    const r = await ensureMeasurementId(site({ id: 42 }), { admin: adminWith([web('G-MINE00001', 'https://superrank.si')]), saveFn: async (x) => { saved.push(x); } });
    assert.equal(r.saved, true);
    assert.deepEqual(saved, [{ siteId: 42, ga4MeasurementId: 'G-MINE00001' }]);
  });
  test('nothing is saved when nothing is found', async () => {
    const saved = [];
    await ensureMeasurementId(site(), { admin: adminWith([]), saveFn: async (x) => saved.push(x) });
    assert.deepEqual(saved, []);
  });
  test('a failed save still reports the found id (and says it was not saved); a thrown discovery never escapes', async () => {
    const r = await ensureMeasurementId(site(), { admin: adminWith([web('G-MINE00001', 'https://superrank.si')]), saveFn: async () => { throw new Error('db'); } });
    assert.equal(r.measurementId, 'G-MINE00001');
    assert.equal(r.saved, false);
  });
});

describe('needsInputMessage', () => {
  test('says what is missing for each client-actionable status, and nothing for a temporary one', () => {
    for (const s of ['no-property', 'no-web-stream', 'ambiguous', 'permission-denied']) assert.match(needsInputMessage(s), /^Needs input:/);
    assert.equal(needsInputMessage('unavailable'), null);
    assert.equal(needsInputMessage('found'), null);
  });
});
