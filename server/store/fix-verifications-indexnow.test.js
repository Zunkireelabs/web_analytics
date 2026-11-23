import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verificationMethodFor, VERIFICATION_METHOD } from './fix-verifications.js';
import { judgeSiteAsset } from '../agents/lib/fix-verification.js';

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('how a merged IndexNow key file is verified', () => {
  test('by fetching https://<site>/<key>.txt and requiring exactly the key', () => {
    const plan = verificationMethodFor({ action_type: 'indexnow', content: { key: KEY } }, { siteOrigin: 'https://example.com' });
    assert.deepEqual(plan, { method: VERIFICATION_METHOD.SITE_ASSET, target: `https://example.com/${KEY}.txt`, expected: { structure: 'indexnow-key', key: KEY } });
  });
  test('without a site origin or a key it cannot be checked, and says so', () => {
    for (const [draft, opts] of [[{ action_type: 'indexnow', content: { key: KEY } }, {}], [{ action_type: 'indexnow', content: {} }, { siteOrigin: 'https://example.com' }]]) {
      assert.equal(verificationMethodFor(draft, opts).method, VERIFICATION_METHOD.UNVERIFIABLE);
    }
  });
});

describe('judgeSiteAsset', () => {
  test('indexnow-key: present only when the served text is the key (whitespace around it aside)', () => {
    assert.equal(judgeSiteAsset('indexnow-key', `${KEY}\n`, { key: KEY }).present, true);
    assert.equal(judgeSiteAsset('indexnow-key', 'other', { key: KEY }).present, false);
    assert.equal(judgeSiteAsset('indexnow-key', `${KEY} extra`, { key: KEY }).present, false);
    assert.equal(judgeSiteAsset('indexnow-key', KEY, {}).present, false, 'no recorded key: nothing to compare to');
  });
  test('llms-txt keeps its own rule, and an unknown structure counts as present once served (as before)', () => {
    assert.equal(judgeSiteAsset('llms-txt', 'not a valid llms file', {}).present, false);
    assert.equal(judgeSiteAsset('something-new', 'x', {}).present, true);
  });
});
