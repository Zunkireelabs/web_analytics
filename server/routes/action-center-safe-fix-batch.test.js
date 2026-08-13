import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import router, { SAFE_FIX_BATCH_LIMIT } from './action-center.js';

// This repo has no supertest/nock convention (confirmed by inspection — see
// implementers/lib/insertion-engine.test.js's own note), so these assert on
// the router's real registered stack rather than driving HTTP. That's still
// enough to catch the two ways the safe-fix batch change can silently break.

const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);

describe('Execute Safe Fixes — batch limit', () => {
  test('one manual run ships up to 30 recommendations', () => {
    assert.equal(SAFE_FIX_BATCH_LIMIT, 30);
  });

  test('the limit is exported, so the UI can label the button with the real cap', () => {
    // The Action Center reads this back off /execution-stats/today instead of
    // keeping its own copy. Before that, 15 was written once on the server and
    // three more times in ActionCenter.jsx — the exact hand-mirrored-constant
    // drift that had already broken two other lists in this app.
    assert.equal(typeof SAFE_FIX_BATCH_LIMIT, 'number');
    assert.ok(SAFE_FIX_BATCH_LIMIT > 0);
  });
});

describe('execution-jobs route ordering', () => {
  test('/execution-jobs/latest is registered BEFORE /execution-jobs/:id', () => {
    // Express matches in declaration order. Registered the other way round,
    // '/latest' is swallowed by ':id', the handler tries to look up a job
    // whose id is the string "latest", and the timeout-recovery path returns
    // 404 forever — a failure that only shows up on exactly the slow, large
    // batches the recovery path exists for.
    const latest = paths.indexOf('/action-center/execution-jobs/latest');
    const byId = paths.indexOf('/action-center/execution-jobs/:id');
    assert.notEqual(latest, -1, '/action-center/execution-jobs/latest is not registered at all');
    assert.notEqual(byId, -1, '/action-center/execution-jobs/:id is not registered at all');
    assert.ok(latest < byId, `'/latest' (index ${latest}) must be declared before '/:id' (index ${byId})`);
  });
});
