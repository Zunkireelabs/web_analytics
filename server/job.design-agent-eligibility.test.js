import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  queueDesignAgentDerivationForSite, queueDesignAgentDerivationsForAllSites,
  queueDesignProfileRescanForSite, queueDesignProfileRescanForAllSites,
} from './job.js';

// Design Agent capabilities (whole-site profile derivation, and by the same
// gate, the capability-repair Design Agent path) used to be keyed off
// site.design_agent_enabled — a flag with no route, UI, or onboarding step
// that ever set it, so it could only be true via a hand-written SQL UPDATE.
// Eligibility is now derived from site.auto_remediation_enabled instead: the
// SAME real-repo-edit/PR consent this codebase already requires a human to
// grant once (routes/clients.js's platform_admin-only /auto-remediation
// route), rather than a second, separate, unreachable toggle. These tests
// prove the three required outcomes generically — no tenant-specific
// hardcoding — via the module's own injectable-deps surface (same pattern
// design-drift.js's resolveOrCreateComponentTemplate already uses), a plain
// import with no module mocking: job.js's own import graph reaches openai's
// formdata-node dependency, which fails to load under node:test's
// module-mocking loader (see job.analyst-sync.test.js's precedent — it also
// imports job.js directly, unmocked, for the same reason).

let createdJobs;

beforeEach(() => {
  createdJobs = [];
});

const fakeDeps = (overrides = {}) => ({
  hasUsableProfile: () => false,
  findQueuedProfileJob: async () => null,
  enqueueProfileJob: async (siteId, opts) => { createdJobs.push({ siteId, ...opts }); return { id: createdJobs.length }; },
  resolvePageUrl: (site) => `https://${site.repo_name}.example.com`,
  ...overrides,
});

describe('queueDesignAgentDerivationForSite — auto_remediation_enabled derives eligibility, not design_agent_enabled', () => {
  test('repo connected + auto_remediation_enabled true -> eligible, queues a derivation', async () => {
    const site = { id: 1, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: true };
    const queued = await queueDesignAgentDerivationForSite(site, fakeDeps());
    assert.equal(queued, true);
    assert.equal(createdJobs.length, 1);
    assert.equal(createdJobs[0].siteId, 1);
  });

  test('repo connected + auto_remediation_enabled false -> not eligible, never reaches the deps', async () => {
    const site = { id: 2, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: false };
    let touched = false;
    const deps = fakeDeps({
      hasUsableProfile: () => { touched = true; return false; },
      findQueuedProfileJob: async () => { touched = true; return null; },
    });
    const queued = await queueDesignAgentDerivationForSite(site, deps);
    assert.equal(queued, false);
    assert.equal(touched, false, 'the ineligibility gate must short-circuit before any dependency is called');
    assert.equal(createdJobs.length, 0);
  });

  test('no repo connected -> not eligible regardless of auto_remediation_enabled', async () => {
    const site = { id: 3, repo_owner: null, repo_name: null, auto_remediation_enabled: true };
    let touched = false;
    const deps = fakeDeps({ hasUsableProfile: () => { touched = true; return false; } });
    const queued = await queueDesignAgentDerivationForSite(site, deps);
    assert.equal(queued, false);
    assert.equal(touched, false);
    assert.equal(createdJobs.length, 0);
  });

  test('legacy design_agent_enabled has no effect either way — eligibility never reads it', async () => {
    const onlyLegacyFlag = { id: 4, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: false, design_agent_enabled: true };
    assert.equal(await queueDesignAgentDerivationForSite(onlyLegacyFlag, fakeDeps()), false);

    const onlyRealFlag = { id: 5, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: true, design_agent_enabled: false };
    assert.equal(await queueDesignAgentDerivationForSite(onlyRealFlag, fakeDeps()), true);
  });

  test('a site that already has a usable design profile is not re-queued, even when eligible', async () => {
    const site = { id: 6, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: true };
    const queued = await queueDesignAgentDerivationForSite(site, fakeDeps({ hasUsableProfile: () => true }));
    assert.equal(queued, false);
    assert.equal(createdJobs.length, 0);
  });
});

describe('queueDesignAgentDerivationsForAllSites — generic across the whole tenant list, no per-tenant special-casing', () => {
  test('only sites with a connected repo AND a granted auto-remediation review get queued', async () => {
    const sites = [
      { id: 10, repo_owner: 'a', repo_name: 'a-web', auto_remediation_enabled: true }, // eligible
      { id: 11, repo_owner: 'b', repo_name: 'b-web', auto_remediation_enabled: false }, // repo only, unreviewed
      { id: 12, repo_owner: null, repo_name: null, auto_remediation_enabled: true }, // reviewed, no repo
      { id: 13, repo_owner: 'd', repo_name: 'd-web', auto_remediation_enabled: true }, // eligible
    ];
    const queuedSites = [];
    const result = await queueDesignAgentDerivationsForAllSites({
      listAllSites: async () => sites,
      queueForSite: async (site) => { queuedSites.push(site.id); return true; },
    });

    assert.equal(result.queued, 2);
    assert.deepEqual(queuedSites.sort(), [10, 13], 'the ineligible sites (11, 12) must never even reach queueForSite');
  });

  test('an empty eligible set queues nothing and never calls queueForSite', async () => {
    let calls = 0;
    const result = await queueDesignAgentDerivationsForAllSites({
      listAllSites: async () => [{ id: 20, repo_owner: null, repo_name: null, auto_remediation_enabled: true }],
      queueForSite: async () => { calls++; return true; },
    });
    assert.equal(result.queued, 0);
    assert.equal(calls, 0);
  });
});

// The weekly refresh half — deliberately the mirror image of the
// first-derivation tests above: it only ever acts on a site that ALREADY
// has a usable profile, and only once that profile is old enough.
describe('queueDesignProfileRescanForSite — refreshes an existing profile, never a first derivation', () => {
  const FRESH_ISO = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day old
  const STALE_ISO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days old

  const fakeRescanDeps = (overrides = {}) => ({
    hasUsableProfile: () => true,
    getProfile: () => ({ derivedAt: STALE_ISO }),
    findQueuedProfileJob: async () => null,
    enqueueProfileJob: async (siteId, opts) => { createdJobs.push({ siteId, ...opts }); return { id: createdJobs.length }; },
    resolvePageUrl: (site) => `https://${site.repo_name}.example.com`,
    ...overrides,
  });

  test('a site with no usable profile yet is left to the first-derivation path, not re-queued here', async () => {
    const site = { id: 30, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: true };
    const queued = await queueDesignProfileRescanForSite(site, fakeRescanDeps({ hasUsableProfile: () => false }));
    assert.equal(queued, false);
    assert.equal(createdJobs.length, 0);
  });

  test('a profile derived within the staleness window is left alone', async () => {
    const site = { id: 31, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: true };
    const queued = await queueDesignProfileRescanForSite(site, fakeRescanDeps({ getProfile: () => ({ derivedAt: FRESH_ISO }) }));
    assert.equal(queued, false);
    assert.equal(createdJobs.length, 0);
  });

  test('a profile older than the staleness window is queued for a fresh analysis', async () => {
    const site = { id: 32, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: true };
    const queued = await queueDesignProfileRescanForSite(site, fakeRescanDeps());
    assert.equal(queued, true);
    assert.equal(createdJobs.length, 1);
    assert.equal(createdJobs[0].siteId, 32);
  });

  test('a profile with no derivedAt at all (should not happen, but must not throw) is treated as due', async () => {
    const site = { id: 33, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: true };
    const queued = await queueDesignProfileRescanForSite(site, fakeRescanDeps({ getProfile: () => ({}) }));
    assert.equal(queued, true);
  });

  test('a rescan already queued is not duplicated', async () => {
    const site = { id: 34, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: true };
    const queued = await queueDesignProfileRescanForSite(site, fakeRescanDeps({ findQueuedProfileJob: async () => ({ id: 999 }) }));
    assert.equal(queued, false);
    assert.equal(createdJobs.length, 0);
  });

  test('no repo / not auto-remediation-enabled short-circuits before touching the profile at all', async () => {
    const site = { id: 35, repo_owner: null, repo_name: null, auto_remediation_enabled: true };
    let touched = false;
    const queued = await queueDesignProfileRescanForSite(site, fakeRescanDeps({ hasUsableProfile: () => { touched = true; return true; } }));
    assert.equal(queued, false);
    assert.equal(touched, false);
  });
});

describe('queueDesignProfileRescanForAllSites', () => {
  test('only eligible sites reach queueForSite', async () => {
    const sites = [
      { id: 40, repo_owner: 'a', repo_name: 'a-web', auto_remediation_enabled: true },
      { id: 41, repo_owner: 'b', repo_name: 'b-web', auto_remediation_enabled: false },
    ];
    const queuedSites = [];
    const result = await queueDesignProfileRescanForAllSites({
      listAllSites: async () => sites,
      queueForSite: async (site) => { queuedSites.push(site.id); return true; },
    });
    assert.equal(result.queued, 1);
    assert.deepEqual(queuedSites, [40]);
  });
});
