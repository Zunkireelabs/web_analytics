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

  // design_task.py already tells apart WHY the sandbox was unavailable —
  // Docker itself unreachable, the model API key rejected, or the container
  // crashed after it started — each needing a different fix. Real incident
  // (2026-08-24): jobs 628 and 1091 on site 1 both collapsed into the one
  // generic AGENT_SANDBOX_UNAVAILABLE code with causeCode: null, because
  // only a boolean (isEnvironment) crossed from openhands-handler.js into
  // this function — the specific errorClass Python computed was discarded
  // at that boundary, even though job 1091 ran AFTER container-diagnostic
  // capture was added, so the data existed and was still lost.
  describe('classifyFailure — the specific sandbox sub-cause (err.pythonErrorClass), not just "unavailable"', () => {
    test('ENVIRONMENT_DOCKER_UNAVAILABLE gets its own errorCode and message', () => {
      const c = classifyFailure({ stage: 'python_environment', err: Object.assign(new Error('x'), { pythonErrorClass: 'ENVIRONMENT_DOCKER_UNAVAILABLE' }) });
      assert.equal(c.errorCode, 'AGENT_SANDBOX_DOCKER_UNAVAILABLE');
      assert.match(c.message, /Docker/);
      assert.equal(c.failureClass, FAILURE_CLASS.DEPLOYMENT);
      assert.equal(c.infrastructure, true);
    });

    test('ENVIRONMENT_MODEL_AUTH gets its own errorCode and message', () => {
      const c = classifyFailure({ stage: 'python_environment', err: Object.assign(new Error('x'), { pythonErrorClass: 'ENVIRONMENT_MODEL_AUTH' }) });
      assert.equal(c.errorCode, 'AGENT_SANDBOX_MODEL_AUTH_FAILED');
      assert.match(c.message, /credentials/);
    });

    test('ENVIRONMENT_CONTAINER_CRASHED gets its own errorCode and message', () => {
      const c = classifyFailure({ stage: 'python_environment', err: Object.assign(new Error('x'), { pythonErrorClass: 'ENVIRONMENT_CONTAINER_CRASHED' }) });
      assert.equal(c.errorCode, 'AGENT_SANDBOX_CONTAINER_CRASHED');
      assert.match(c.message, /stopped unexpectedly/);
    });

    // Added 2026-08-24: real staging job 1354 revealed design_task.py's
    // DockerWorkspace()-construction exception handler only ever recognized
    // docker/daemon/api-key text — a health-check-timeout failure (which
    // never mentions either word) fell through to no errorClass at all,
    // silently misclassified as AGENT_LOGIC. ENVIRONMENT_CONTAINER_UNHEALTHY
    // is the fix on the Python side; this is its Node-side counterpart.
    test('ENVIRONMENT_CONTAINER_UNHEALTHY gets its own errorCode and message', () => {
      const c = classifyFailure({ stage: 'python_environment', err: Object.assign(new Error('x'), { pythonErrorClass: 'ENVIRONMENT_CONTAINER_UNHEALTHY' }) });
      assert.equal(c.errorCode, 'AGENT_SANDBOX_CONTAINER_UNHEALTHY');
      assert.match(c.message, /never became healthy/);
      assert.equal(c.failureClass, FAILURE_CLASS.DEPLOYMENT);
      assert.equal(c.infrastructure, true);
    });

    test('an unrecognized pythonErrorClass falls back to the original generic code, never guessed', () => {
      const c = classifyFailure({ stage: 'python_environment', err: Object.assign(new Error('x'), { pythonErrorClass: 'ENVIRONMENT_SOMETHING_FUTURE_PYTHON_ADDED' }) });
      assert.equal(c.errorCode, 'AGENT_SANDBOX_UNAVAILABLE');
    });

    test('no pythonErrorClass at all (the pre-fix shape) is unchanged — exact backward compatibility', () => {
      const c = classifyFailure({ stage: 'python_environment', err: new Error('Docker is not available') });
      assert.equal(c.errorCode, 'AGENT_SANDBOX_UNAVAILABLE');
      assert.equal(c.diagnostics, undefined);
    });

    test('containerDiagnostics carried on the error are persisted, structurally filtered', () => {
      const err = Object.assign(new Error('x'), {
        pythonErrorClass: 'ENVIRONMENT_CONTAINER_CRASHED',
        containerDiagnostics: {
          exitCode: 137, oomKilled: true, status: 'exited', logsTail: 'boot log line\nOOMKilled',
          notARealField: 'should be dropped',
        },
      });
      const c = classifyFailure({ stage: 'python_environment', err });
      assert.deepEqual(c.diagnostics, {
        exitCode: 137, oomKilled: true, status: 'exited', logsTail: 'boot log line\nOOMKilled',
      });
      assert.equal('notARealField' in c.diagnostics, false, 'only the known docker-inspect/docker-logs fields are ever carried through');
    });

    test('a very long logsTail is capped, matching the Python side\'s own 4000-char limit', () => {
      const err = Object.assign(new Error('x'), {
        pythonErrorClass: 'ENVIRONMENT_CONTAINER_CRASHED',
        containerDiagnostics: { logsTail: 'x'.repeat(10000) },
      });
      const c = classifyFailure({ stage: 'python_environment', err });
      assert.equal(c.diagnostics.logsTail.length, 4000);
    });

    test('no containerDiagnostics at all means no diagnostics field is added — never a fabricated empty object', () => {
      const c = classifyFailure({ stage: 'python_environment', err: Object.assign(new Error('x'), { pythonErrorClass: 'ENVIRONMENT_DOCKER_UNAVAILABLE' }) });
      assert.equal(c.diagnostics, undefined);
    });

    // Added 2026-08-24: the raw exception text design_task.py's outer
    // handler caught is the one field that actually tells apart "permission
    // denied on the socket" from "no such host" from a genuine timeout —
    // all of which otherwise collapse into the same
    // AGENT_SANDBOX_DOCKER_UNAVAILABLE code with no way to diagnose which
    // one actually happened without shelling into the VPS.
    test('rawError is carried through and capped independently of logsTail', () => {
      const err = Object.assign(new Error('x'), {
        pythonErrorClass: 'ENVIRONMENT_CONTAINER_UNHEALTHY',
        containerDiagnostics: { rawError: 'Container failed to become healthy in time' },
      });
      const c = classifyFailure({ stage: 'python_environment', err });
      assert.equal(c.diagnostics.rawError, 'Container failed to become healthy in time');
    });

    test('a very long rawError is capped to 1000 chars', () => {
      const err = Object.assign(new Error('x'), {
        pythonErrorClass: 'ENVIRONMENT_CONTAINER_UNHEALTHY',
        containerDiagnostics: { rawError: 'x'.repeat(5000) },
      });
      const c = classifyFailure({ stage: 'python_environment', err });
      assert.equal(c.diagnostics.rawError.length, 1000);
    });
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
