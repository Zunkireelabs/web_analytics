import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasProfileLevelMismatch, repairProfileLevelMismatch, DESIGN_ROLE_MISMATCH_PATTERN } from './design-mismatch-repair.js';

describe('hasProfileLevelMismatch', () => {
  test('recognises the profile-level defect that regeneration can never fix', () => {
    assert.equal(hasProfileLevelMismatch([{ patternId: DESIGN_ROLE_MISMATCH_PATTERN }]), true);
  });

  test('a purely content-level mismatch is not routed to the profile repairer', () => {
    assert.equal(hasProfileLevelMismatch([{ patternId: 'structure-section-count' }]), false);
    assert.equal(hasProfileLevelMismatch([]), false);
    assert.equal(hasProfileLevelMismatch(null), false);
  });
});

describe('repairProfileLevelMismatch — DIAGNOSE -> ROUTE -> repair -> revalidate', () => {
  const ROW = { id: 7, name: 'acme', url_file_map: { siteRoot: { designProfile: { typography: {} } } } };

  test('runs the deterministic role correction and returns the REFRESHED site', async () => {
    const calls = [];
    const corrected = { id: 7, url_file_map: { siteRoot: { designProfile: { corrected: true } } } };

    const result = await repairProfileLevelMismatch(7, {
      loadSiteRow: async (id) => { calls.push(['load', id]); return ROW; },
      repairSites: async (sites, opts) => { calls.push(['repair', sites[0].id, opts.commit]); return { examined: 1, changed: 1, failed: 0 }; },
      fetchSite: async (id) => { calls.push(['refetch', id]); return corrected; },
    });

    assert.equal(result.repaired, true);
    assert.deepEqual(result.site, corrected, 'the caller must revalidate against the CORRECTED profile, not the stale copy');
    assert.deepEqual(calls, [['load', 7], ['repair', 7, true], ['refetch', 7]]);
  });

  test('a repair that changes nothing reports repaired:false and never refetches', async () => {
    const calls = [];
    const result = await repairProfileLevelMismatch(7, {
      loadSiteRow: async () => ROW,
      repairSites: async () => ({ examined: 1, changed: 0, failed: 0 }),
      fetchSite: async () => { calls.push('refetch'); return {}; },
    });
    assert.equal(result.repaired, false);
    assert.deepEqual(calls, [], 'nothing changed, so there is nothing to re-read');
  });

  test('a throwing repair is swallowed — self-healing must never be louder than the original problem', async () => {
    const result = await repairProfileLevelMismatch(7, {
      loadSiteRow: async () => ROW,
      repairSites: async () => { throw new Error('profile write failed'); },
      fetchSite: async () => ({}),
    });
    assert.equal(result.repaired, false);
    assert.equal(result.site, null);
  });

  test('a site with no row is a no-op, never a crash', async () => {
    const result = await repairProfileLevelMismatch(7, {
      loadSiteRow: async () => null,
      repairSites: async () => { throw new Error('must not be called'); },
      fetchSite: async () => ({}),
    });
    assert.equal(result.repaired, false);
  });

  test('missing collaborators are a no-op rather than a throw', async () => {
    assert.deepEqual(await repairProfileLevelMismatch(7, {}), { repaired: false, site: null });
    assert.deepEqual(await repairProfileLevelMismatch(null, {}), { repaired: false, site: null });
  });
});
