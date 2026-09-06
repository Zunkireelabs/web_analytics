import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query } from '../db.js';
import { createDesignAgentJob } from '../store/execution-jobs.js';
import { processOneJob } from './worker.js';
import { UserFacingError } from '../lib/errors.js';

// Retry policy coverage, against the real DB (job state transitions and the
// persisted failure shape are the point — a mock pool would prove nothing
// about what a reader actually finds on the row afterwards).
//
// The property under test: the system distinguishes something transient it
// may safely re-attempt from something that requires a fix and from something
// outside its authority — and NEVER retries the latter two. A blanket retry
// would re-run a full repo analysis against a fault that cannot succeed,
// burning model spend and hiding a broken deployment behind an attempt count.

const siteIds = [];

async function makeSite() {
  const stamp = `worker-retry-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows } = await query(
    `INSERT INTO sites (name, gsc_property, ga4_property_id, timezone)
     VALUES ('design-agent-worker-retry.test.js fixture', $1, $2, 'UTC')
     RETURNING id`,
    [stamp, stamp]
  );
  siteIds.push(rows[0].id);
  return rows[0].id;
}

// Cleanup runs even for rows a mid-suite failure left behind. A hard process
// kill still skips this (node's `after` cannot survive SIGKILL) — the reason
// routes/clients.js also filters these fixture names out of staff-facing
// lists rather than trusting cleanup alone.
after(async () => {
  if (siteIds.length) {
    await query('DELETE FROM execution_jobs WHERE site_id = ANY($1::int[])', [siteIds]);
    await query('DELETE FROM sites WHERE id = ANY($1::int[])', [siteIds]);
  }
  await pool.end();
});

// No real sleeping — the retry CONTROL FLOW is what matters, not wall-clock
// backoff. Records what the backoff WOULD have been so the schedule is still
// asserted.
function fakeSleep(recorded) {
  return async (ms) => { recorded.push(ms); };
}

// Throws a classified failure of a chosen kind, succeeding on `succeedOnAttempt`.
function flakyHandler({ stage, code, succeedOnAttempt = Infinity, outcome = { ok: true } }) {
  let attempts = 0;
  const handler = async () => {
    attempts += 1;
    if (attempts >= succeedOnAttempt) return outcome;
    const err = new UserFacingError('induced failure');
    err.stage = stage;
    if (code) err.code = code;
    throw err;
  };
  handler.attemptCount = () => attempts;
  return handler;
}

async function jobRow(id) {
  const { rows } = await query('SELECT status, result, logs FROM execution_jobs WHERE id = $1', [id]);
  return rows[0];
}

// See worker.test.js's "concurrency — two workers racing the same queue"
// describe block: a real worker.js instance may be polling this same shared
// database, and its own default claim (no siteId — real deployments poll
// globally, across every tenant, by design) can claim ANY site's queued
// design_generate job — including one of this suite's single-job fixtures,
// in the window between this test creating it and its own scoped
// processOneJob call. When that happens processOneJob finds nothing left to
// claim for this (otherwise idle, throwaway) site: a false failure, not a
// retry-policy regression. Retrying with a freshly created job recovers the
// real signal; two independent external steals inside one test run would be
// extraordinary, so exhausting `attempts` here is a genuine failure.
async function withOwnJob(siteId, { makeHandler, options = {} }, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const job = await createDesignAgentJob(siteId, null, { params: { mode: 'fixture-demo' } });
    const slept = [];
    const handler = makeHandler();
    const result = await processOneJob({ handler, siteId, sleep: fakeSleep(slept), ...options });
    if (result) return { job, handler, slept, result };
    if (attempt === attempts) {
      throw new Error(`Job ${job.id} (site ${siteId}) was claimed by another process on all ${attempts} attempt(s) — an external worker is stealing this fixture before this test's own scoped claim runs.`);
    }
  }
}

describe('processOneJob — retry policy', () => {
  test('a transient EXTERNAL_SERVICE failure is retried and can succeed', async () => {
    const siteId = await makeSite();
    const { job, handler, slept, result } = await withOwnJob(siteId, {
      makeHandler: () => flakyHandler({ stage: 'repo_checkout', code: 'ETIMEDOUT', succeedOnAttempt: 2 }),
    });

    assert.equal(result.status, 'completed', 'a recovered job completes normally');
    assert.equal(handler.attemptCount(), 2, 'exactly one retry was needed');
    assert.deepEqual(slept, [2000], 'backoff was applied before the retry');
    const row = await jobRow(job.id);
    assert.equal(row.status, 'completed', 'job state is correct after a successful retry');
  });

  test('a transient failure that never recovers stops at the bounded limit', async () => {
    const siteId = await makeSite();
    const { job, handler, slept, result } = await withOwnJob(siteId, {
      makeHandler: () => flakyHandler({ stage: 'repo_checkout', code: 'ETIMEDOUT' }), // never succeeds
      options: { maxAttempts: 3 },
    });

    assert.equal(result.status, 'failed');
    assert.equal(handler.attemptCount(), 3, 'bounded — never an infinite loop');
    assert.deepEqual(slept, [2000, 4000], 'backoff grew between attempts');
    const row = await jobRow(job.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.result.failure.attempts, 3, 'the attempt count is persisted');
    assert.equal(row.result.failure.failureClass, 'FAILED_BECAUSE_EXTERNAL_SERVICE_IS_UNAVAILABLE');
  });

  test('a DEPLOYMENT failure is never retried', async () => {
    const siteId = await makeSite();
    const { job, handler, slept, result } = await withOwnJob(siteId, {
      makeHandler: () => flakyHandler({ stage: 'python_startup', code: 'ENOENT' }),
    });

    assert.equal(result.status, 'failed');
    assert.equal(handler.attemptCount(), 1, 'retrying cannot install a missing interpreter');
    assert.deepEqual(slept, [], 'no backoff — it never waited to try again');
    const row = await jobRow(job.id);
    assert.equal(row.result.failure.failureClass, 'FAILED_BECAUSE_DEPLOYMENT_IS_BROKEN');
    assert.equal(row.result.failure.infrastructure, true, 'flagged as outside the application\'s authority');
  });

  test('a CLIENT_REPO failure is never retried automatically', async () => {
    const siteId = await makeSite();
    // Same stage as the transient case above — only the errno differs. This
    // is the distinction the whole policy rests on.
    const { handler, slept, result } = await withOwnJob(siteId, {
      makeHandler: () => flakyHandler({ stage: 'repo_checkout', code: null }),
    });

    assert.equal(result.status, 'failed');
    assert.equal(handler.attemptCount(), 1);
    assert.deepEqual(slept, []);
    const row = await jobRow(result.jobId);
    assert.equal(row.result.failure.failureClass, 'FAILED_BECAUSE_CLIENT_REPOSITORY_IS_BROKEN');
  });

  test('an AGENT_LOGIC failure is never retried', async () => {
    const siteId = await makeSite();
    const { handler, result } = await withOwnJob(siteId, {
      makeHandler: () => flakyHandler({ stage: 'result_validation' }),
    });

    assert.equal(result.status, 'failed');
    assert.equal(handler.attemptCount(), 1, 'the same input would produce the same bad output');
    const row = await jobRow(result.jobId);
    assert.equal(row.result.failure.failureClass, 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG');
  });

  test('the ORIGINAL failure is preserved when a retry later fails differently', async () => {
    const siteId = await makeSite();
    const { result } = await withOwnJob(siteId, {
      makeHandler: () => {
        let attempts = 0;
        return async () => {
          attempts += 1;
          const err = new UserFacingError('induced');
          // Transient first (so it retries), then a different, terminal fault.
          if (attempts === 1) { err.stage = 'agent_run'; err.timedOut = true; }
          else { err.stage = 'result_validation'; }
          throw err;
        };
      },
    });

    const row = await jobRow(result.jobId);
    assert.equal(row.result.failure.errorCode, 'AGENT_RESULT_UNUSABLE', 'final failure is recorded');
    assert.equal(row.result.failure.firstFailure.errorCode, 'AGENT_RUN_TIMEOUT',
      'the original trigger is not lost behind the last symptom');
  });

  test('secrets never enter the persisted failure information', async () => {
    const siteId = await makeSite();
    const { result } = await withOwnJob(siteId, {
      makeHandler: () => async () => {
        // A realistic provider error: carries a token and a hostname.
        const err = new Error('remote: Invalid credentials ghp_LIVESECRET123 for https://api.github.com/repos/x/y');
        err.stage = 'repo_checkout';
        throw err;
      },
    });

    const row = await jobRow(result.jobId);
    const persisted = JSON.stringify(row.result) + JSON.stringify(row.logs);
    assert.equal(persisted.includes('ghp_LIVESECRET123'), false, 'the token must never reach a readable row');
    assert.equal(persisted.includes('api.github.com'), false, 'nor the provider hostname');
  });
});
