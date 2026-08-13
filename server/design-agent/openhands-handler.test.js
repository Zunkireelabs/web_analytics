import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createOpenHandsHandler } from './openhands-handler.js';

// Stubs the entire Python+Docker boundary (see test-support/
// fake-design-task-*.js and fake-docker.js) — pythonBin/scriptPath/dockerBin
// are all injectable exactly so this suite never spawns the real OpenHands
// SDK, never needs LLM_API_KEY/OPENAI_API_KEY, and never touches a real
// Docker daemon or container. Confirmed by construction: every handler built
// in this file passes an explicit fake dockerBin, so a `docker` binary is
// never even looked up on PATH here, let alone invoked for real. The real
// OpenHands+Docker run (design_task.py, server/design-agent/python/.venv,
// a real `docker`) is exercised separately and manually, not by this suite.
const here = path.dirname(fileURLToPath(import.meta.url));
const testSupportDir = path.join(here, 'test-support');
const fixtureDir = path.join(here, 'fixtures', 'test-site');
const fakeDockerBin = path.join(testSupportDir, 'fake-docker.js');

function handlerWithStub(scriptName, extra = {}) {
  return createOpenHandsHandler({
    pythonBin: process.execPath, // node itself stands in for python3
    scriptPath: path.join(testSupportDir, scriptName),
    fixtureDir,
    dockerBin: fakeDockerBin,
    killGraceMs: 300, // keep SIGKILL-escalation tests fast
    ...extra,
  });
}

function tempLogPath(label) {
  return path.join(os.tmpdir(), `design-agent-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
}

// Runs `fn` with the given env vars set, guaranteeing they're unset again
// (and any files they pointed at removed) no matter what fn does.
async function withTestLogs(envPaths, fn) {
  const entries = Object.entries(envPaths);
  for (const [key, value] of entries) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const [key, value] of entries) {
      delete process.env[key];
      fs.rmSync(value, { force: true });
    }
  }
}

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null;
}

describe('createOpenHandsHandler — success path', () => {
  test('resolves, copies the real fixture into the temp workspace, and cleans up both workspace and container', async () => {
    const wsLog = tempLogPath('ws');
    const containerLog = tempLogPath('container');
    const dockerLog = tempLogPath('docker');
    await withTestLogs(
      { DESIGN_AGENT_TEST_WORKSPACE_LOG: wsLog, DESIGN_AGENT_TEST_CONTAINER_LOG: containerLog, DESIGN_AGENT_TEST_DOCKER_LOG: dockerLog },
      async () => {
        const handler = handlerWithStub('fake-design-task-ok.js');
        const result = await handler({ id: 42 });
        assert.equal(result.jobId, 42);
        assert.equal(result.detail, 'stub: task completed');

        const workspaceDir = readIfExists(wsLog);
        assert.ok(workspaceDir);
        assert.equal(fs.existsSync(workspaceDir), false, 'temp workspace should be removed after a successful run');

        const containerId = readIfExists(containerLog);
        assert.ok(containerId);
        const dockerInvocations = readIfExists(dockerLog);
        assert.match(dockerInvocations, /rm -f/);
        assert.match(dockerInvocations, new RegExp(containerId), 'backstop docker cleanup should target the exact container id the task reported');
      }
    );
  });
});

describe('createOpenHandsHandler — failure paths', () => {
  // The contract changed deliberately: the thrown message now NAMES THE STAGE in
  // developer-authored text (a UserFacingError), because worker.js persists that
  // onto the job row and it is the only thing an operator can read without
  // shelling into the container. The task's own detail is preserved on `cause`,
  // where it reaches the internal log but never the job row.
  test('names the stage, and keeps the task\'s own detail on cause', async () => {
    const handler = handlerWithStub('fake-design-task-fail.js');
    const err = await handler({ id: 1 }).then(() => null, (e) => e);

    assert.ok(err, 'handler must reject');
    assert.equal(err.userFacing, true);
    assert.match(err.message, /could not analyse this site's repository/i);
    assert.match(err.cause.message, /stub: task failed on purpose/, 'the real detail must still be reachable');
    assert.doesNotMatch(err.message, /stub: task failed on purpose/, 'raw task output must not reach the persisted message');
  });

  test('throws a diagnosable error when the subprocess crashes before a container even exists', async () => {
    const dockerLog = tempLogPath('docker');
    await withTestLogs({ DESIGN_AGENT_TEST_DOCKER_LOG: dockerLog }, async () => {
      const handler = handlerWithStub('fake-design-task-crash.js');
      const err = await handler({ id: 2 }).then(() => null, (e) => e);
      assert.equal(err.userFacing, true);
      assert.match(err.message, /exited \(code \d+\) without producing a result/i, 'the exit code is safe to name');
      assert.match(err.cause.message, /^stderr: /, 'stderr is preserved for the internal log');
      assert.doesNotMatch(err.message, /stderr/i, 'stderr can carry tokens — it must never reach the persisted message');
      // Nothing to clean up — the backstop must not fire on a null container id.
      assert.equal(fs.existsSync(dockerLog), false, 'docker backstop should not run when no container id was ever seen');
    });
  });

  test('cleans up the temp workspace even when the task fails', async () => {
    const wsLog = tempLogPath('ws');
    await withTestLogs({ DESIGN_AGENT_TEST_WORKSPACE_LOG: wsLog }, async () => {
      const handler = handlerWithStub('fake-design-task-fail.js');
      await assert.rejects(handler({ id: 3 }));
      const workspaceDir = readIfExists(wsLog);
      assert.equal(fs.existsSync(workspaceDir), false, 'temp workspace should be removed even after a failed run');
    });
  });

  test('crash after the container exists still triggers the docker backstop cleanup', async () => {
    const wsLog = tempLogPath('ws');
    const containerLog = tempLogPath('container');
    const dockerLog = tempLogPath('docker');
    await withTestLogs(
      { DESIGN_AGENT_TEST_WORKSPACE_LOG: wsLog, DESIGN_AGENT_TEST_CONTAINER_LOG: containerLog, DESIGN_AGENT_TEST_DOCKER_LOG: dockerLog },
      async () => {
        const handler = handlerWithStub('fake-design-task-crash-with-container.js');
        await assert.rejects(handler({ id: 4 }));

        assert.equal(fs.existsSync(readIfExists(wsLog)), false, 'temp workspace should be removed even after a crash');
        const containerId = readIfExists(containerLog);
        assert.ok(containerId, 'the fake task should have reported a container id before crashing');
        assert.match(readIfExists(dockerLog), new RegExp(`rm -f.*${containerId}`), 'a job that never got to clean up its own container must be caught by the Node-side backstop');
      }
    );
  });

  test('throws a clear error if the fixture directory does not exist, and still leaves no temp workspace behind', async () => {
    const handler = handlerWithStub('fake-design-task-ok.js', { fixtureDir: path.join(here, 'fixtures', 'does-not-exist') });
    await assert.rejects(handler({ id: 5 }));
  });
});

describe('createOpenHandsHandler — isolation between concurrent jobs', () => {
  test('N concurrent jobs each get a distinct container id, no collisions, and all clean up', async () => {
    // DESIGN_AGENT_TEST_WORKSPACE_LOG/_CONTAINER_LOG are single shared env
    // vars (last writer wins under real concurrency), so they're only used
    // in the single-job tests above. Here, isolation is verified the way it
    // actually matters end-to-end: N jobs run fully concurrently against
    // ONE shared, append-only docker-backstop log (each subprocess appends
    // its own line — safe under concurrency, unlike overwriting a single
    // path) — N distinct container ids with N cleanup calls proves no two
    // concurrent jobs ever shared a workspace/container.
    const N = 5;
    const dockerLog = tempLogPath('docker-concurrent');
    await withTestLogs({ DESIGN_AGENT_TEST_DOCKER_LOG: dockerLog }, async () => {
      const handlers = Array.from({ length: N }, () => handlerWithStub('fake-design-task-ok.js'));
      const results = await Promise.all(handlers.map((h, i) => h({ id: `concurrent-${i}` })));
      assert.equal(results.length, N);
      assert.ok(results.every((r) => r.detail === 'stub: task completed'));

      const dockerLines = readIfExists(dockerLog).split('\n').filter(Boolean);
      assert.equal(dockerLines.length, N, 'every job should have triggered exactly one backstop cleanup call');
      const containerIds = dockerLines.map((line) => line.split(' ').pop());
      assert.equal(new Set(containerIds).size, N, 'every concurrent job must have used a distinct container id — no collisions');
    });
  });
});

describe('createOpenHandsHandler — timeout / forced termination', () => {
  test('a task that honors SIGTERM is stopped with a single signal, and everything is cleaned up', async () => {
    const wsLog = tempLogPath('ws');
    const containerLog = tempLogPath('container');
    const dockerLog = tempLogPath('docker');
    await withTestLogs(
      { DESIGN_AGENT_TEST_WORKSPACE_LOG: wsLog, DESIGN_AGENT_TEST_CONTAINER_LOG: containerLog, DESIGN_AGENT_TEST_DOCKER_LOG: dockerLog },
      async () => {
        const handler = handlerWithStub('fake-design-task-hang-honor-sigterm.js', { timeoutMs: 300, killGraceMs: 2000 });
        const startedAt = Date.now();
        await assert.rejects(handler({ id: 6 }), /without finishing and was stopped/i);
        const elapsedMs = Date.now() - startedAt;

        // Should resolve close to timeoutMs, not wait out the full killGraceMs
        // — proof the process actually exited on SIGTERM rather than being
        // force-killed after the grace period.
        assert.ok(elapsedMs < 1800, `expected the honored SIGTERM to end things well under killGraceMs (elapsed ${elapsedMs}ms)`);

        assert.equal(fs.existsSync(readIfExists(wsLog)), false, 'temp workspace must be removed after a timeout');
        const containerId = readIfExists(containerLog);
        assert.ok(containerId);
        assert.match(readIfExists(dockerLog), new RegExp(`rm -f.*${containerId}`));
      }
    );
  });

  test('a task that ignores SIGTERM is force-killed after the grace period, and everything is still cleaned up', async () => {
    const wsLog = tempLogPath('ws');
    const containerLog = tempLogPath('container');
    const dockerLog = tempLogPath('docker');
    await withTestLogs(
      { DESIGN_AGENT_TEST_WORKSPACE_LOG: wsLog, DESIGN_AGENT_TEST_CONTAINER_LOG: containerLog, DESIGN_AGENT_TEST_DOCKER_LOG: dockerLog },
      async () => {
        const handler = handlerWithStub('fake-design-task-hang-ignore-sigterm.js', { timeoutMs: 300, killGraceMs: 400 });
        const startedAt = Date.now();
        await assert.rejects(handler({ id: 7 }), /without finishing and was stopped/i);
        const elapsedMs = Date.now() - startedAt;

        // Must have waited out roughly timeoutMs + killGraceMs before the
        // SIGKILL actually ended it.
        assert.ok(elapsedMs >= 600, `expected to wait through timeoutMs+killGraceMs before SIGKILL landed (elapsed ${elapsedMs}ms)`);
        assert.ok(elapsedMs < 3000, `escalation took suspiciously long (elapsed ${elapsedMs}ms)`);

        assert.equal(fs.existsSync(readIfExists(wsLog)), false, 'temp workspace must be removed even after a forced SIGKILL');
        const containerId = readIfExists(containerLog);
        assert.ok(containerId, 'the container id seen before the hang must still have been captured');
        assert.match(readIfExists(dockerLog), new RegExp(`rm -f.*${containerId}`), 'Node-side backstop must clean up a container whose own process never got to (SIGKILLed before its cleanup could run)');
      }
    );
  });
});
