import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, shouldRetry, FAILURE_CLASS } from './failure-classification.js';

// The property under test throughout: a job must never end with an
// undifferentiated failure. Every one of these cases was a real, observed
// failure mode that previously recorded only "Design Agent job failed
// unexpectedly" — indistinguishable from each other, and therefore
// undiagnosable without shelling into the worker container.
describe('classifyFailure', () => {
  test('a missing interpreter is a DEPLOYMENT fault, never retried', () => {
    // The exact failure that stalled every design-profile job on site 1.
    const c = classifyFailure({ stage: 'python_startup', err: { code: 'ENOENT' } });
    assert.equal(c.failureClass, FAILURE_CLASS.DEPLOYMENT);
    assert.equal(c.errorCode, 'PYTHON_EXECUTABLE_MISSING');
    assert.equal(c.recoverable, false, 'retrying cannot install an interpreter');
    assert.equal(c.infrastructure, true);
  });

  test('a spawn errno alone is enough — no stage required', () => {
    const c = classifyFailure({ err: { code: 'EACCES' } });
    assert.equal(c.failureClass, FAILURE_CLASS.DEPLOYMENT);
  });

  test('an unavailable sandbox is DEPLOYMENT, not agent logic', () => {
    // Confirmed live: with Docker stopped, the agent reported "Docker is not
    // available" through its ordinary result channel and was classed as
    // AGENT_LOGIC — blaming the agent for a host fault.
    const c = classifyFailure({ stage: 'python_environment', err: new Error('Docker is not available') });
    assert.equal(c.failureClass, FAILURE_CLASS.DEPLOYMENT);
    assert.equal(c.errorCode, 'AGENT_SANDBOX_UNAVAILABLE');
    assert.equal(c.infrastructure, true);
  });

  test('a rejected repo is the CLIENT\'s to fix, and is not retried', () => {
    const c = classifyFailure({ stage: 'repo_checkout', err: new Error('401 Bad credentials') });
    assert.equal(c.failureClass, FAILURE_CLASS.CLIENT_REPO);
    assert.equal(c.recoverable, false);
  });

  test('a network fault reaching the repo host is EXTERNAL, and IS retried', () => {
    // Same stage as above, opposite handling — the distinction that makes
    // retrying safe here and pointless there.
    const c = classifyFailure({ stage: 'repo_checkout', err: { code: 'ETIMEDOUT' } });
    assert.equal(c.failureClass, FAILURE_CLASS.EXTERNAL_SERVICE);
    assert.equal(c.recoverable, true);
  });

  test('a timeout is transient and retryable', () => {
    const c = classifyFailure({ stage: 'agent_run', timedOut: true });
    assert.equal(c.failureClass, FAILURE_CLASS.EXTERNAL_SERVICE);
    assert.equal(c.recoverable, true);
  });

  test('a non-zero exit without a result is DEPLOYMENT — Python ran but its deps did not', () => {
    const c = classifyFailure({ stage: 'agent_run', exitCode: 1 });
    assert.equal(c.errorCode, 'AGENT_PROCESS_EXITED');
    assert.equal(c.failureClass, FAILURE_CLASS.DEPLOYMENT);
  });

  test('a rejected result is the agent\'s own fault', () => {
    const c = classifyFailure({ stage: 'result_validation', err: new Error('missing placeholder') });
    assert.equal(c.failureClass, FAILURE_CLASS.AGENT_LOGIC);
    assert.equal(c.recoverable, false, 'the same input would produce the same bad output');
  });

  test('an unknown failure is treated as OURS, never silently as transient', () => {
    // Deliberate: a new failure mode must surface loudly rather than be
    // absorbed into a retry loop that hides it, which is how the original
    // breakage stayed invisible for a day.
    const c = classifyFailure({ err: new Error('something new') });
    assert.equal(c.failureClass, FAILURE_CLASS.AGENT_LOGIC);
    assert.equal(c.errorCode, 'UNCLASSIFIED_FAILURE');
    assert.equal(c.recoverable, false);
  });

  test('never leaks the underlying cause text into the persisted shape', () => {
    // This object is written to a job row a customer-facing surface reads;
    // provider error bodies must stay in the internal log only.
    const c = classifyFailure({ stage: 'repo_checkout', err: new Error('token ghp_SECRET rejected by api.github.com') });
    assert.equal(JSON.stringify(c).includes('ghp_SECRET'), false);
    assert.equal(JSON.stringify(c).includes('api.github.com'), false);
  });
});

describe('shouldRetry', () => {
  test('retries only transient classes, and only within the attempt cap', () => {
    const transient = classifyFailure({ stage: 'agent_run', timedOut: true });
    const deployment = classifyFailure({ stage: 'python_startup', err: { code: 'ENOENT' } });

    assert.equal(shouldRetry(transient, 1), true);
    assert.equal(shouldRetry(transient, 3), false, 'cap reached — stop and report honestly');
    assert.equal(shouldRetry(deployment, 1), false, 'a broken deployment is never retried into working');
  });
});
