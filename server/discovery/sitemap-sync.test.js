import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { syncSitemapIntoInventory } from './sitemap-sync.js';

const site = { id: 1, gsc_property: 'sc-domain:example.com' };
const mk = ({ sitemap, inventory = [], resubmit } = {}) => {
  const calls = { upserts: [], resubmits: 0 };
  return {
    calls,
    deps: {
      discover: async () => { if (sitemap instanceof Error) throw sitemap; return sitemap; },
      listInventory: async () => inventory.map((page) => ({ page })),
      upsert: async (siteId, pages, via) => { calls.upserts.push({ siteId, pages, via }); },
      resubmit: resubmit || (async () => { calls.resubmits++; return { ok: true }; }),
    },
  };
};

describe('syncSitemapIntoInventory', () => {
  test('adds only the sitemap URLs the inventory does not have, tagged as sitemap discoveries', async () => {
    const { deps, calls } = mk({ sitemap: ['https://a.com/blog/old/', 'https://a.com/blog/new-1/', 'https://a.com/blog/new-2/'], inventory: ['https://a.com/blog/old/'] });
    const r = await syncSitemapIntoInventory(site, deps);
    assert.equal(r.added, 2);
    assert.deepEqual(calls.upserts, [{ siteId: 1, pages: ['https://a.com/blog/new-1/', 'https://a.com/blog/new-2/'], via: 'sitemap' }]);
  });
  test('a trailing slash is not a different page', async () => {
    const { deps, calls } = mk({ sitemap: ['https://a.com/blog/x'], inventory: ['https://a.com/blog/x/'] });
    assert.equal((await syncSitemapIntoInventory(site, deps)).added, 0);
    assert.equal(calls.upserts.length, 0);
  });
  test('nothing new: no write and no resubmit', async () => {
    const { deps, calls } = mk({ sitemap: ['https://a.com/'], inventory: ['https://a.com/'] });
    await syncSitemapIntoInventory(site, deps);
    assert.equal(calls.upserts.length, 0);
    assert.equal(calls.resubmits, 0);
  });
  test('something new: Search Console is asked to re-read the sitemap once', async () => {
    const { deps, calls } = mk({ sitemap: ['https://a.com/new/'], inventory: [] });
    const r = await syncSitemapIntoInventory(site, deps);
    assert.equal(calls.resubmits, 1);
    assert.deepEqual(r.sitemapResubmit, { ok: true });
  });
  test('a failing resubmit never undoes or hides the discovery', async () => {
    const { deps } = mk({ sitemap: ['https://a.com/new/'], resubmit: async () => { throw new Error('insufficient scope'); } });
    const r = await syncSitemapIntoInventory(site, deps);
    assert.equal(r.added, 1);
    assert.equal(r.sitemapResubmit.ok, false);
  });
  test('an unreadable or empty sitemap is skipped, never treated as "everything is gone"', async () => {
    for (const sitemap of [new Error('boom'), [], null]) {
      const { deps, calls } = mk({ sitemap, inventory: ['https://a.com/x/'] });
      const r = await syncSitemapIntoInventory(site, deps);
      assert.equal(r.added, 0);
      assert.ok(r.skipped);
      assert.equal(calls.upserts.length, 0);
    }
  });
  test('duplicates inside the sitemap are added once', async () => {
    const { deps, calls } = mk({ sitemap: ['https://a.com/n/', 'https://a.com/n'], inventory: [] });
    await syncSitemapIntoInventory(site, deps);
    assert.equal(calls.upserts[0].pages.length, 1);
  });
});
