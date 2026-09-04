import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { queueConsistencyScanForSite, queueConsistencyScanForAllSites } from './job.js';

// Same unmocked-direct-import pattern as job.design-agent-eligibility.test.js
// (see that file's own comment) — job.js's import graph reaches openai's
// formdata-node dependency, which breaks under node:test's mock.module, so
// this exercises the real function via its injectable-deps DI surface
// instead of mocking anything.

let createdJobs;

beforeEach(() => { createdJobs = []; });

const fakeDeps = (overrides = {}) => ({
  hasUsableProfile: () => true,
  findQueuedScanJob: async () => null,
  getLatestScanJob: async () => null,
  enqueueScanJob: async (siteId, opts) => { createdJobs.push({ siteId, ...opts }); return { id: createdJobs.length }; },
  resolvePageUrl: (site) => `https://${site.repo_name}.example.com`,
  now: () => Date.now(),
  ...overrides,
});

const SITE = { id: 1, repo_owner: 'acme', repo_name: 'acme-web', auto_remediation_enabled: true };

describe('queueConsistencyScanForSite', () => {
  test('an eligible site with a usable profile and no pending/recent scan gets queued', async () => {
    const queued = await queueConsistencyScanForSite(SITE, fakeDeps());
    assert.equal(queued, true);
    assert.equal(createdJobs.length, 1);
    assert.equal(createdJobs[0].siteId, 1);
  });

  test('no repo connected -> ineligible, never even checks the profile', async () => {
    const site = { id: 2, repo_owner: null, repo_name: null, auto_remediation_enabled: true };
    let touched = false;
    const queued = await queueConsistencyScanForSite(site, fakeDeps({ hasUsableProfile: () => { touched = true; return true; } }));
    assert.equal(queued, false);
    assert.equal(touched, false);
    assert.equal(createdJobs.length, 0);
  });

  test('no usable stored profile yet -> never queued (nothing real to compare against)', async () => {
    const queued = await queueConsistencyScanForSite(SITE, fakeDeps({ hasUsableProfile: () => false }));
    assert.equal(queued, false);
    assert.equal(createdJobs.length, 0);
  });

  test('a scan already queued or executing for this site is never duplicated', async () => {
    const queued = await queueConsistencyScanForSite(SITE, fakeDeps({ findQueuedScanJob: async () => ({ id: 99 }) }));
    assert.equal(queued, false);
    assert.equal(createdJobs.length, 0);
  });

  test('a scan that finished less than 7 days ago is not re-queued', async () => {
    const now = Date.parse('2026-09-10T00:00:00Z');
    const finishedAt = Date.parse('2026-09-05T00:00:00Z'); // 5 days ago
    const queued = await queueConsistencyScanForSite(SITE, fakeDeps({
      getLatestScanJob: async () => ({ finished_at: new Date(finishedAt).toISOString() }),
      now: () => now,
    }));
    assert.equal(queued, false);
  });

  test('a scan that finished more than 7 days ago IS re-queued', async () => {
    const now = Date.parse('2026-09-10T00:00:00Z');
    const finishedAt = Date.parse('2026-09-01T00:00:00Z'); // 9 days ago
    const queued = await queueConsistencyScanForSite(SITE, fakeDeps({
      getLatestScanJob: async () => ({ finished_at: new Date(finishedAt).toISOString() }),
      now: () => now,
    }));
    assert.equal(queued, true);
  });
});

describe('queueConsistencyScanForAllSites', () => {
  test('only eligible sites reach queueForSite', async () => {
    const sites = [
      { id: 10, repo_owner: 'a', repo_name: 'a-web', auto_remediation_enabled: true },
      { id: 11, repo_owner: null, repo_name: null, auto_remediation_enabled: true },
    ];
    const queuedSites = [];
    const result = await queueConsistencyScanForAllSites({
      listAllSites: async () => sites,
      queueForSite: async (site) => { queuedSites.push(site.id); return true; },
    });
    assert.equal(result.queued, 1);
    assert.deepEqual(queuedSites, [10]);
  });
});
