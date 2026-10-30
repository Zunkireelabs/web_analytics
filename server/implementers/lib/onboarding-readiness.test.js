import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isOnboardingAnalysisPending, FIRST_DESIGN_PROFILE_TIMEOUT_MS, designCaptureNeedsPerson } from './onboarding-readiness.js';

// Two-stage onboarding: connect-repo (server/routes/clients.js, server/scripts/connect-repo.js)
// grants auto_remediation_enabled AND queues the whole-site analysis job
// (DESIGN_PROFILE_JOB_KEY) in the same moment, but repair execution
// (repair-template-capability.js's live branch, auto-remediation.js's
// PR-opening loop) must wait for that analysis to reach a terminal state.
// This function is the single shared predicate both call sites use.

const FULL_PROFILE = {
  typography: { body: 'text-base', heading: { item: 'text-lg', section: 'text-2xl' } },
  layout: { container: 'max-w-6xl' }, spacing: { section: 'py-12', itemGap: 'gap-4' },
  color: { primary: '#000' }, responsive: { md: 1 }, components: { card: {} }, navigation: { header: 1 },
  pages: [{ url: '/' }], pageTypePatterns: { blog: {} },
};
const fullSite = (id = 1) => ({ id, url_file_map: { siteRoot: { designProfile: FULL_PROFILE } } });

describe('isOnboardingAnalysisPending', () => {
  test('a site with an already-usable design profile is never pending — no DB call at all', async () => {
    let jobLookups = 0;
    const pending = await isOnboardingAnalysisPending(fullSite(), {
      hasUsableProfile: () => true,
      latestProfileJob: async () => { jobLookups++; return null; },
    });
    assert.equal(pending, false);
    assert.equal(jobLookups, 0, 'a usable profile is conclusive on its own — must not even query the job row');
  });

  test('no profile yet, no job record at all -> pending, and a first derivation gets queued right there', async () => {
    let enqueued = null;
    const pending = await isOnboardingAnalysisPending({ id: 1 }, {
      hasUsableProfile: () => false,
      latestProfileJob: async () => null,
      enqueueProfileJob: async (siteId, opts) => { enqueued = { siteId, opts }; },
      resolvePageUrl: () => 'https://example.com',
    });
    assert.equal(pending, true, 'nothing in flight yet — must not silently ship with zero design-baseline context');
    assert.deepEqual(enqueued, { siteId: 1, opts: { requestedBy: null, pageUrl: 'https://example.com' } });
  });

  test('no profile yet, no job record, enqueue itself throws -> still reports pending rather than shipping blind', async () => {
    const pending = await isOnboardingAnalysisPending({ id: 1 }, {
      hasUsableProfile: () => false,
      latestProfileJob: async () => null,
      enqueueProfileJob: async () => { throw new Error('db down'); },
    });
    assert.equal(pending, true);
  });

  for (const status of ['queued', 'executing']) {
    test(`no profile yet, job status "${status}" within the timeout -> pending, no duplicate enqueue`, async () => {
      let enqueueCalls = 0;
      const pending = await isOnboardingAnalysisPending({ id: 1 }, {
        hasUsableProfile: () => false,
        latestProfileJob: async () => ({ status, created_at: new Date().toISOString() }),
        enqueueProfileJob: async () => { enqueueCalls++; },
      });
      assert.equal(pending, true);
      assert.equal(enqueueCalls, 0, 'a job already in flight must never be re-queued');
    });

    test(`no profile yet, job status "${status}" stuck PAST the timeout -> still held, and a fresh derivation is queued`, async () => {
      const queuedAt = new Date(Date.now() - FIRST_DESIGN_PROFILE_TIMEOUT_MS - 1000).toISOString();
      let enqueueCalls = 0;
      const pending = await isOnboardingAnalysisPending({ id: 1 }, {
        hasUsableProfile: () => false,
        latestProfileJob: async () => ({ status, created_at: queuedAt }),
        enqueueProfileJob: async () => { enqueueCalls++; },
      });
      assert.equal(pending, true, 'a client without a captured design must never ship');
      assert.equal(enqueueCalls, 1);
    });
  }

  test('failed capture, past the backoff -> held and retried', async () => {
    let enqueueCalls = 0;
    const pending = await isOnboardingAnalysisPending({ id: 1 }, {
      hasUsableProfile: () => false,
      latestProfileJob: async () => ({ status: 'failed', finished_at: new Date(Date.now() - 2 * 3600e3).toISOString() }),
      recentProfileJobs: async () => [{}],
      enqueueProfileJob: async () => { enqueueCalls++; },
    });
    assert.equal(pending, true);
    assert.equal(enqueueCalls, 1);
  });

  test('completed without a usable profile, inside the backoff -> held, no re-queue yet', async () => {
    let enqueueCalls = 0;
    const pending = await isOnboardingAnalysisPending({ id: 1 }, {
      hasUsableProfile: () => false,
      latestProfileJob: async () => ({ status: 'completed', finished_at: new Date().toISOString() }),
      enqueueProfileJob: async () => { enqueueCalls++; },
    });
    assert.equal(pending, true);
    assert.equal(enqueueCalls, 0);
  });

  test('attempts exhausted -> still held, no endless re-queueing', async () => {
    let enqueueCalls = 0;
    const pending = await isOnboardingAnalysisPending({ id: 1 }, {
      hasUsableProfile: () => false,
      maxAttempts: 3,
      latestProfileJob: async () => ({ status: 'failed', finished_at: new Date(Date.now() - 9 * 3600e3).toISOString() }),
      recentProfileJobs: async () => [{}, {}, {}],
      enqueueProfileJob: async () => { enqueueCalls++; },
    });
    assert.equal(pending, true);
    assert.equal(enqueueCalls, 0);
  });

  test('a usable but thin capture is not held, yet a fuller capture is requested', async () => {
    let enqueueCalls = 0;
    const thin = { id: 9, url_file_map: { siteRoot: { designProfile: { typography: { body: 'x', heading: { item: 'y' } }, layout: { container: 'z' } } } } };
    const pending = await isOnboardingAnalysisPending(thin, {
      hasUsableProfile: () => true,
      latestProfileJob: async () => null,
      enqueueProfileJob: async () => { enqueueCalls++; },
    });
    assert.equal(pending, false);
    assert.equal(enqueueCalls, 1);
  });

  test('an established site with an existing (even stale) profile is completely unaffected', async () => {
    let jobLookups = 0;
    let enqueueCalls = 0;
    const pending = await isOnboardingAnalysisPending(fullSite(), {
      hasUsableProfile: () => true,
      latestProfileJob: async () => { jobLookups++; return null; },
      enqueueProfileJob: async () => { enqueueCalls++; },
    });
    assert.equal(pending, false);
    assert.equal(jobLookups, 0);
    assert.equal(enqueueCalls, 0);
  });

  test('queries the whole-site profile job for THIS site\'s id, not a hardcoded one — generic across tenants', async () => {
    const seenSiteIds = [];
    for (const siteId of [7, 42, 501]) {
      await isOnboardingAnalysisPending({ id: siteId }, {
        hasUsableProfile: () => false,
        latestProfileJob: async (id) => { seenSiteIds.push(id); return null; },
        enqueueProfileJob: async () => {},
      });
    }
    assert.deepEqual(seenSiteIds, [7, 42, 501]);
  });
});

describe('designCaptureNeedsPerson — held until a person looks', () => {
  const site = { id: 3 };
  const jobs = (n) => async () => Array.from({ length: n }, (_, i) => ({ id: i }));
  const base = { hasUsableProfile: () => false, maxAttempts: 5 };

  test('true only after every allowed try has failed', async () => {
    assert.equal(await designCaptureNeedsPerson(site, { ...base, latestProfileJob: async () => ({ status: 'failed' }), recentProfileJobs: jobs(5) }), true);
    assert.equal(await designCaptureNeedsPerson(site, { ...base, latestProfileJob: async () => ({ status: 'failed' }), recentProfileJobs: jobs(2) }), false);
  });
  test('false while a capture is still queued or running, or when there is a usable profile', async () => {
    assert.equal(await designCaptureNeedsPerson(site, { ...base, latestProfileJob: async () => ({ status: 'executing' }), recentProfileJobs: jobs(5) }), false);
    assert.equal(await designCaptureNeedsPerson(site, { ...base, latestProfileJob: async () => ({ status: 'queued' }), recentProfileJobs: jobs(5) }), false);
    assert.equal(await designCaptureNeedsPerson(site, { ...base, hasUsableProfile: () => true, latestProfileJob: async () => ({ status: 'failed' }), recentProfileJobs: jobs(5) }), false);
  });
  test('false when no capture was ever requested (that case starts one, it is not a person problem)', async () => {
    assert.equal(await designCaptureNeedsPerson(site, { ...base, latestProfileJob: async () => null, recentProfileJobs: jobs(0) }), false);
  });
});
