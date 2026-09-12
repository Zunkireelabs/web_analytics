import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isOnboardingAnalysisPending, FIRST_DESIGN_PROFILE_TIMEOUT_MS } from './onboarding-readiness.js';

// Two-stage onboarding: connect-repo (server/routes/clients.js, server/scripts/connect-repo.js)
// grants auto_remediation_enabled AND queues the whole-site analysis job
// (DESIGN_PROFILE_JOB_KEY) in the same moment, but repair execution
// (repair-template-capability.js's live branch, auto-remediation.js's
// PR-opening loop) must wait for that analysis to reach a terminal state.
// This function is the single shared predicate both call sites use.

describe('isOnboardingAnalysisPending', () => {
  test('a site with an already-usable design profile is never pending — no DB call at all', async () => {
    let jobLookups = 0;
    const pending = await isOnboardingAnalysisPending({ id: 1 }, {
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

    test(`no profile yet, job status "${status}" pending PAST the timeout -> not pending (ships anyway)`, async () => {
      const queuedAt = new Date(Date.now() - FIRST_DESIGN_PROFILE_TIMEOUT_MS - 1000).toISOString();
      const pending = await isOnboardingAnalysisPending({ id: 1 }, {
        hasUsableProfile: () => false,
        latestProfileJob: async () => ({ status, created_at: queuedAt }),
        enqueueProfileJob: async () => { throw new Error('must not be called'); },
      });
      assert.equal(pending, false, 'a stuck/failed-to-finish job must not block a client from shipping forever');
    });
  }

  for (const status of ['completed', 'failed']) {
    test(`no profile yet, job status "${status}" (terminal) -> not pending`, async () => {
      const pending = await isOnboardingAnalysisPending({ id: 1 }, {
        hasUsableProfile: () => false,
        latestProfileJob: async () => ({ status }),
      });
      assert.equal(pending, false, 'a terminal job — success OR failure — must never block repair forever');
    });
  }

  test('an established site with an existing (even stale) profile is completely unaffected', async () => {
    let jobLookups = 0;
    let enqueueCalls = 0;
    const pending = await isOnboardingAnalysisPending({ id: 1 }, {
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
