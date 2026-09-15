import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isConfirmedBlocked } from './index-status.js';

describe('isConfirmedBlocked', () => {
  test('false when there is no index_status at all', () => {
    assert.equal(isConfirmedBlocked(null), false);
    assert.equal(isConfirmedBlocked(undefined), false);
  });

  test('true for a robots.txt disallow verdict', () => {
    assert.equal(isConfirmedBlocked({ robotsTxtState: 'DISALLOWED', indexingState: 'INDEXING_ALLOWED' }), true);
  });

  test('true for each recognized blocking indexingState', () => {
    for (const state of ['BLOCKED_BY_META_TAG', 'BLOCKED_BY_HTTP_HEADER', 'BLOCKED_BY_ROBOTS_TXT']) {
      assert.equal(isConfirmedBlocked({ robotsTxtState: 'ALLOWED', indexingState: state }), true);
    }
  });

  test('false when both signals report clear', () => {
    assert.equal(isConfirmedBlocked({ robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED' }), false);
  });
});
