import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPruneInventoryRow } from './page-inventory.js';

describe('shouldPruneInventoryRow', () => {
  const p = 'https://a.com/old/';
  test('never prunes a page the live sitemap lists, even if it is broken', () => {
    assert.equal(shouldPruneInventoryRow({ page: p, inSitemap: true, status: 404 }), false);
    assert.equal(shouldPruneInventoryRow({ page: 'https://a.com/?h=1', inSitemap: true, status: 200 }), false);
  });
  test('prunes parameter duplicates and non-https variants without needing a probe', () => {
    assert.equal(shouldPruneInventoryRow({ page: 'https://a.com/?h=123', inSitemap: false, status: null }), true);
    assert.equal(shouldPruneInventoryRow({ page: 'http://a.com/', inSitemap: false, status: null }), true);
  });
  test('prunes redirected, not-found and gone pages that are not in the sitemap', () => {
    for (const status of [301, 302, 307, 308, 404, 410]) {
      assert.equal(shouldPruneInventoryRow({ page: p, inSitemap: false, status }), true, `status ${status}`);
    }
  });
  test('keeps real pages, server errors and unreachable probes', () => {
    for (const status of [200, 500, 503, null]) {
      assert.equal(shouldPruneInventoryRow({ page: p, inSitemap: false, status }), false, `status ${status}`);
    }
  });
});
