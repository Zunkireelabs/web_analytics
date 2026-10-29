import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runSiteDiscoveryIfDue, runSiteDiscoveryIfDueForAllSites } from './job.js';

// Plain dependency injection, no module mocking — same convention
// job.design-agent-eligibility.test.js already uses successfully for this
// file's other queue functions.
const SITE = { id: 900, timezone: 'UTC' };

const fakeDeps = (overrides = {}) => ({
  getLastDiscoveryAtFn: async () => null,
  discoverFromSitemapsFn: async () => ['https://example.com/news/'],
  crawlSiteFn: async () => ['https://example.com/'],
  getSearchPerformanceRangeFn: async () => [],
  upsertPageInventoryBatchFn: async () => {},
  markOrphanedPagesFn: async () => {},
  ensureSitemapRegisteredFn: async () => ({ status: 'already-registered', sitemaps: [] }),
  ...overrides,
});

describe('runSiteDiscoveryIfDue — force bypasses the weekly staleness gate', () => {
  test('a site discovered within the current week is skipped by default', async () => {
    const result = await runSiteDiscoveryIfDue(SITE, fakeDeps({ getLastDiscoveryAtFn: async () => new Date().toISOString() }));
    assert.equal(result, null);
  });

  // force-site-discovery.js's whole reason to exist: page_inventory can go
  // stale because the SITE's own sitemap changed, not just because time
  // passed — confirmed on chayceproperties.com, whose real sitemap.xml
  // lists /news/ but whose stored page_inventory never picked it up because
  // no run happened since it was added. `force` is the one-time catch-up.
  test('force re-runs discovery even for a site discovered this week', async () => {
    const upserts = [];
    const result = await runSiteDiscoveryIfDue(SITE, fakeDeps({
      getLastDiscoveryAtFn: async () => new Date().toISOString(),
      upsertPageInventoryBatchFn: async (siteId, urls, source) => { upserts.push({ siteId, urls, source }); },
      force: true,
    }));
    assert.notEqual(result, null);
    assert.ok(upserts.some((u) => u.source === 'sitemap' && u.urls.includes('https://example.com/news/')));
  });

  test('a genuinely stale site still runs without force', async () => {
    const result = await runSiteDiscoveryIfDue(SITE, fakeDeps({ getLastDiscoveryAtFn: async () => '2020-01-01T00:00:00.000Z' }));
    assert.notEqual(result, null);
  });

  test('a sitemap fetch failure degrades to empty rather than throwing', async () => {
    const result = await runSiteDiscoveryIfDue(SITE, fakeDeps({ discoverFromSitemapsFn: async () => { throw new Error('network'); } }));
    assert.equal(result.sitemapCount, 0);
  });

  // Real incident: chayceproperties.com's GSC breakdown included a prior
  // owner's legacy /shop/*.aspx and ?h=<digits> URLs, which passed the
  // own-domain check and were being upserted into page_inventory as real
  // 'gsc' pages every week.
  test('legacy foreign-platform URLs from GSC never reach page_inventory', async () => {
    const upserts = [];
    const result = await runSiteDiscoveryIfDue(SITE, fakeDeps({
      getSearchPerformanceRangeFn: async () => [
        { dim_value: 'https://example.com/', impressions: 5 },
        { dim_value: 'https://example.com/shop/storeSearch/KeepCriteriaInput.aspx?&transition=top1', impressions: 3 },
        { dim_value: 'https://example.com/?h=8020347041280', impressions: 1 },
      ],
      upsertPageInventoryBatchFn: async (siteId, urls, source) => { upserts.push({ siteId, urls, source }); },
    }));
    const gscUpsert = upserts.find((u) => u.source === 'gsc');
    assert.deepEqual(gscUpsert.urls, ['https://example.com/']);
    assert.equal(result.gscCount, 1);
  });
});

describe('runSiteDiscoveryIfDueForAllSites — force threads through to every site', () => {
  test('force is passed to runForSite for every connected site', async () => {
    const sites = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const forceValues = [];
    const results = await runSiteDiscoveryIfDueForAllSites({
      force: true,
      listAllSites: async () => sites,
      runForSite: async (site, opts) => { forceValues.push(opts?.force); return { siteId: site.id }; },
    });
    assert.deepEqual(forceValues, [true, true, true]);
    assert.equal(results.length, 3);
  });

  test('without force, the flag defaults to false', async () => {
    const forceValues = [];
    await runSiteDiscoveryIfDueForAllSites({
      listAllSites: async () => [{ id: 1 }],
      runForSite: async (site, opts) => { forceValues.push(opts?.force); return null; },
    });
    assert.deepEqual(forceValues, [false]);
  });

  test('one site failing does not stop the rest', async () => {
    const sites = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
    const results = await runSiteDiscoveryIfDueForAllSites({
      force: true,
      listAllSites: async () => sites,
      runForSite: async (site) => { if (site.id === 1) throw new Error('boom'); return { siteId: site.id }; },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].siteId, 2);
  });
});

describe('runSiteDiscoveryIfDue — registers the sitemap before reading it', () => {
  test('runs the registration before the sitemap is read, and returns its outcome', async () => {
    const order = [];
    const result = await runSiteDiscoveryIfDue(SITE, fakeDeps({
      ensureSitemapRegisteredFn: async () => { order.push('register'); return { status: 'submitted', sitemap: 'https://example.com/sitemap.xml' }; },
      discoverFromSitemapsFn: async () => { order.push('read'); return []; },
    }));
    assert.deepEqual(order, ['register', 'read']);
    assert.equal(result.sitemapRegistration.status, 'submitted');
  });

  test('a registration that throws never stops discovery', async () => {
    const result = await runSiteDiscoveryIfDue(SITE, fakeDeps({ ensureSitemapRegisteredFn: async () => { throw new Error('google down'); } }));
    assert.notEqual(result, null);
    assert.equal(result.sitemapRegistration.status, 'failed');
  });

  test('a week already discovered does not touch Search Console again', async () => {
    let called = false;
    await runSiteDiscoveryIfDue(SITE, fakeDeps({
      getLastDiscoveryAtFn: async () => new Date().toISOString(),
      ensureSitemapRegisteredFn: async () => { called = true; return { status: 'skipped' }; },
    }));
    assert.equal(called, false);
  });
});

describe('runSiteDiscoveryIfDueForAllSites — runs inside the morning window', () => {
  const sites = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];

  test('runs every site while the window is open', async () => {
    const ran = [];
    const results = await runSiteDiscoveryIfDueForAllSites({ listAllSites: async () => sites, runForSite: async (s) => { ran.push(s.id); return { id: s.id }; }, windowEndsAt: Date.now() + 60_000 });
    assert.deepEqual(ran, [1, 2]);
    assert.equal(results.length, 2);
  });

  test('starts no new site once the window has closed', async () => {
    const ran = [];
    await runSiteDiscoveryIfDueForAllSites({ listAllSites: async () => sites, runForSite: async (s) => { ran.push(s.id); return {}; }, windowEndsAt: Date.now() - 1 });
    assert.deepEqual(ran, []);
  });

  test('one site failing does not stop the next', async () => {
    const ran = [];
    const results = await runSiteDiscoveryIfDueForAllSites({ listAllSites: async () => sites, runForSite: async (s) => { ran.push(s.id); if (s.id === 1) throw new Error('crawl failed'); return { id: s.id }; } });
    assert.deepEqual(ran, [1, 2]);
    assert.equal(results.length, 1);
  });
});
