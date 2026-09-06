import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runKeywordGapShipCycleForAllSites } from './job.js';

// runKeywordGapShipCycleForAllSites used to skip a site entirely unless a
// per-site 14-day marker (sites.keyword_gap_ship_cycle_last_done) said it was
// due — so most Mondays silently shipped nothing for a site regardless of
// how many gaps had newly qualified. It now runs qualifyAndShipContentGaps
// for every eligible site on every call, relying on that function's own
// evidence-based qualification gate (and per-gap status transition) for
// idempotency instead of a site-level cooldown. These tests exercise the
// job.js wrapper via its injectable-deps surface — see
// job.design-agent-eligibility.test.js's own comment for why a plain
// mock.module of job.js's import graph isn't an option here.

describe('runKeywordGapShipCycleForAllSites — every eligible site, every call, no cooldown', () => {
  test('ships for a site even though it was "shipped" moments ago — no site-level cooldown gates this any more', async () => {
    const site = { id: 1, name: 'Recently Shipped Co' };
    let shipCalls = 0;
    let markedShipped = [];
    const result = await runKeywordGapShipCycleForAllSites({
      listAllSites: async () => [site],
      shipForSite: async (siteId) => { shipCalls++; return { shipped: 2, candidates: 2 }; },
      markShipped: async (siteId) => { markedShipped.push(siteId); },
    });
    assert.equal(shipCalls, 1, 'must actually call qualifyAndShipContentGaps for the site, unconditionally');
    assert.deepEqual(markedShipped, [1]);
    assert.equal(result.sites, 1);
    assert.equal(result.shipped, 2);
  });

  test('one tenant\'s failure does not stop another tenant from shipping (per-site isolation)', async () => {
    const sites = [
      { id: 1, name: 'Broken Co' },
      { id: 2, name: 'Healthy Co' },
      { id: 3, name: 'Also Healthy Co' },
    ];
    const shippedSiteIds = [];
    const result = await runKeywordGapShipCycleForAllSites({
      listAllSites: async () => sites,
      shipForSite: async (siteId) => {
        if (siteId === 1) throw new Error('repo token revoked');
        shippedSiteIds.push(siteId);
        return { shipped: 1, candidates: 1 };
      },
      markShipped: async () => {},
    });
    assert.deepEqual(shippedSiteIds.sort(), [2, 3], 'site 1 failing must never block sites 2 or 3');
    assert.equal(result.sites, 2, 'the failed site must not count toward totals.sites');
    assert.equal(result.shipped, 2);
  });

  test('a Monday batch is per-tenant: each call receives only that site\'s own id and site object, never another tenant\'s', async () => {
    const siteA = { id: 10, name: 'Tenant A' };
    const siteB = { id: 20, name: 'Tenant B' };
    const seenArgs = [];
    await runKeywordGapShipCycleForAllSites({
      listAllSites: async () => [siteA, siteB],
      shipForSite: async (siteId, site) => { seenArgs.push({ siteId, site }); return { shipped: 0, candidates: 0 }; },
      markShipped: async () => {},
    });
    assert.deepEqual(seenArgs, [{ siteId: 10, site: siteA }, { siteId: 20, site: siteB }]);
  });

  test('an empty eligible-site list ships nothing and never throws', async () => {
    const result = await runKeywordGapShipCycleForAllSites({
      listAllSites: async () => [],
      shipForSite: async () => { throw new Error('must never be called'); },
      markShipped: async () => { throw new Error('must never be called'); },
    });
    assert.equal(result.sites, 0);
    assert.equal(result.shipped, 0);
  });
});
