import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isOnboardingAnalysisPending } from './onboarding-readiness.js';

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

  test('no profile yet, no job record at all -> not pending (a site that predates this gate is never newly blocked)', async () => {
    const pending = await isOnboardingAnalysisPending({ id: 1 }, {
      hasUsableProfile: () => false,
      latestProfileJob: async () => null,
    });
    assert.equal(pending, false);
  });

  for (const status of ['queued', 'executing']) {
    test(`no profile yet, job status "${status}" -> pending`, async () => {
      const pending = await isOnboardingAnalysisPending({ id: 1 }, {
        hasUsableProfile: () => false,
        latestProfileJob: async () => ({ status }),
      });
      assert.equal(pending, true);
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

  test('queries the whole-site profile job for THIS site\'s id, not a hardcoded one — generic across tenants', async () => {
    const seenSiteIds = [];
    for (const siteId of [7, 42, 501]) {
      await isOnboardingAnalysisPending({ id: siteId }, {
        hasUsableProfile: () => false,
        latestProfileJob: async (id) => { seenSiteIds.push(id); return null; },
      });
    }
    assert.deepEqual(seenSiteIds, [7, 42, 501]);
  });
});
