import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let recentJobsResult;
let recentJobsCalls;

mock.module(resolve('../../store/execution-jobs.js'), {
  namedExports: {
    getRecentDesignAgentJobs: async (siteId, actionType, limit) => {
      recentJobsCalls.push({ siteId, actionType, limit });
      return recentJobsResult;
    },
    DESIGN_PROFILE_JOB_KEY: '__design-profile__',
  },
});

const { deriveDesignAgentStatus, getDesignAgentStatus, DESIGN_AGENT_STATE } = await import('./design-agent-status.js');

describe('deriveDesignAgentStatus — pure state derivation, no I/O', () => {
  test('never_attempted: succeeded is false and no job has ever run', () => {
    const status = deriveDesignAgentStatus({ succeeded: false, recentJobs: [] });
    assert.equal(status.state, DESIGN_AGENT_STATE.NEVER_ATTEMPTED);
    assert.match(status.detail, /has not been derived yet/i);
  });

  test('queued: the latest job has not started executing yet', () => {
    const status = deriveDesignAgentStatus({ succeeded: false, recentJobs: [{ id: 42, status: 'queued' }] });
    assert.equal(status.state, DESIGN_AGENT_STATE.QUEUED);
    assert.equal(status.jobId, 42);
    assert.match(status.detail, /queued/i);
  });

  test('running: the latest job is actively executing', () => {
    const status = deriveDesignAgentStatus({ succeeded: false, recentJobs: [{ id: 42, status: 'executing' }] });
    assert.equal(status.state, DESIGN_AGENT_STATE.RUNNING);
    assert.equal(status.jobId, 42);
    assert.match(status.detail, /currently running/i);
    assert.doesNotMatch(status.detail, /automatically|no action needed/i, 'must not repeat the old blanket reassurance wording');
  });

  test('succeeded: the caller\'s own "is there a usable result right now" check wins over any job history', () => {
    const status = deriveDesignAgentStatus({ succeeded: true, recentJobs: [{ id: 1, status: 'failed' }] });
    assert.equal(status.state, DESIGN_AGENT_STATE.SUCCEEDED);
    assert.match(status.detail, /up to date/i);
  });

  test('failed: a single failed attempt, not yet "repeated"', () => {
    const status = deriveDesignAgentStatus({
      succeeded: false,
      recentJobs: [{ id: 628, status: 'failed', finished_at: '2026-08-24T00:31:46.267Z', result: { failure: { errorCode: 'AGENT_SANDBOX_UNAVAILABLE', failureClass: 'FAILED_BECAUSE_DEPLOYMENT_IS_BROKEN', recoverable: false, infrastructure: true, attempts: 1 } } }],
    });
    assert.equal(status.state, DESIGN_AGENT_STATE.FAILED);
    assert.equal(status.jobId, 628);
    assert.equal(status.attemptCount, 1);
    assert.equal(status.repeated, false);
    assert.equal(status.failure.errorCode, 'AGENT_SANDBOX_UNAVAILABLE');
    assert.match(status.detail, /failed/i);
    assert.doesNotMatch(status.detail, /will unblock automatically|no action needed/i, 'a failed attempt must never claim automatic resolution');
  });

  test('repeated failure: 2+ consecutive failed jobs escalates the message and sets repeated:true', () => {
    const status = deriveDesignAgentStatus({
      succeeded: false,
      recentJobs: [
        { id: 630, status: 'failed', finished_at: '2026-08-24T05:00:00Z', result: { failure: { errorCode: 'AGENT_SANDBOX_UNAVAILABLE' } } },
        { id: 628, status: 'failed', finished_at: '2026-08-24T00:31:46.267Z', result: { failure: { errorCode: 'AGENT_SANDBOX_UNAVAILABLE' } } },
      ],
    });
    assert.equal(status.state, DESIGN_AGENT_STATE.FAILED);
    assert.equal(status.attemptCount, 2);
    assert.equal(status.repeated, true);
    assert.match(status.detail, /2 times in a row/i);
    assert.match(status.detail, /default fallback template/i);
    assert.doesNotMatch(status.detail, /needs attention|will not resolve itself/i, 'a failed analysis run never blocks drafting, so it must not read as something a human must fix');
  });

  test('successful retry after failure: a fresh SUCCEEDED result outranks an old failure streak entirely', () => {
    // The caller passes succeeded:true once a verified template/profile
    // actually exists — regardless of how many failures preceded it.
    const status = deriveDesignAgentStatus({
      succeeded: true,
      recentJobs: [
        { id: 631, status: 'completed' },
        { id: 630, status: 'failed' },
        { id: 628, status: 'failed' },
      ],
    });
    assert.equal(status.state, DESIGN_AGENT_STATE.SUCCEEDED);
  });

  test('a non-consecutive failure streak (success in between) does not count as repeated', () => {
    const status = deriveDesignAgentStatus({
      succeeded: false,
      recentJobs: [
        { id: 640, status: 'failed', result: { failure: { errorCode: 'X' } } },
        { id: 635, status: 'completed' }, // succeeded once in between — the streak resets here
        { id: 628, status: 'failed', result: { failure: { errorCode: 'AGENT_SANDBOX_UNAVAILABLE' } } },
      ],
    });
    assert.equal(status.attemptCount, 1);
    assert.equal(status.repeated, false);
  });

  test('a completed job whose result the caller still reports as not-succeeded is treated as never_attempted, not stuck', () => {
    // e.g. the handler ran but persisting the derived profile/template failed
    // (worker.js keeps that inside the same try as the handler call) — the
    // site has nothing usable and nothing in flight, so the honest next step
    // is identical to a first attempt.
    const status = deriveDesignAgentStatus({ succeeded: false, recentJobs: [{ id: 50, status: 'completed' }] });
    assert.equal(status.state, DESIGN_AGENT_STATE.NEVER_ATTEMPTED);
  });

  test('never exposes raw failure internals — only the closed, customer-safe fields', () => {
    const status = deriveDesignAgentStatus({
      succeeded: false,
      recentJobs: [{
        id: 1, status: 'failed',
        result: { failure: { errorCode: 'X', failureClass: 'Y', stage: 'z', recoverable: false, infrastructure: true, ref: 'abc', attempts: 2, causeCode: 'ECONNREFUSED', message: 'raw internal detail with a token maybe' } },
      }],
    });
    assert.deepEqual(Object.keys(status.failure).sort(), ['attempts', 'errorCode', 'failureClass', 'infrastructure', 'ref', 'recoverable', 'stage'].sort());
    assert.equal(status.failure.causeCode, undefined);
    assert.equal(status.failure.message, undefined);
  });

  test('a failed job with no result.failure at all (should not happen, but must not throw) reports null failure', () => {
    const status = deriveDesignAgentStatus({ succeeded: false, recentJobs: [{ id: 1, status: 'failed', result: null }] });
    assert.equal(status.state, DESIGN_AGENT_STATE.FAILED);
    assert.equal(status.failure, null);
  });
});

describe('getDesignAgentStatus — I/O wrapper, tenant-scoped', () => {
  test('scopes the query to the given site.id and job key — never another tenant\'s jobs', async () => {
    recentJobsResult = [];
    recentJobsCalls = [];
    await getDesignAgentStatus({ id: 42 }, { succeeded: false });
    assert.equal(recentJobsCalls.length, 1);
    assert.equal(recentJobsCalls[0].siteId, 42);
    assert.equal(recentJobsCalls[0].actionType, '__design-profile__');
  });

  test('a different site.id produces a fully independent query — no cross-tenant leakage', async () => {
    recentJobsResult = [{ id: 1, status: 'failed', result: { failure: { errorCode: 'X' } } }];
    recentJobsCalls = [];
    const statusA = await getDesignAgentStatus({ id: 1 }, { succeeded: false });
    const statusB = await getDesignAgentStatus({ id: 2 }, { succeeded: false });
    assert.deepEqual(recentJobsCalls.map((c) => c.siteId), [1, 2]);
    assert.equal(statusA.state, DESIGN_AGENT_STATE.FAILED);
    assert.equal(statusB.state, DESIGN_AGENT_STATE.FAILED); // same canned mock result, but from an independently-scoped call
  });
});
