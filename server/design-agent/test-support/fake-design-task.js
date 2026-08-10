// TEST-ONLY stand-in for design_task.py, shared by the mode wrappers in this
// directory (fake-design-task-*.js). openhands-handler.js's `pythonBin`/
// `scriptPath`/`dockerBin` are all injectable specifically so tests can
// point at these instead of a real Python interpreter or real `docker` —
// exercises the real spawn + line-by-line stdout parsing + temp-workspace
// copy/cleanup + Docker-backstop-cleanup code paths in
// openhands-handler.test.js without ever invoking the real OpenHands SDK,
// a real LLM API key, or a real Docker daemon/container.
//
// argv[1] is the workspace dir, matching design_task.py's own contract.
// Mirrors design_task.py's real sentinel-line contract:
//   DESIGN_AGENT_CONTAINER: {"container_id": "..."} — printed immediately,
//     for every mode (a real crash can happen after the container exists
//     but before a result line, which is exactly what 'crash' simulates).
//   DESIGN_AGENT_RESULT: {...}                      — printed at the end,
//     except for 'crash'/'hang-ignore-sigterm', which never reach it.
//
// Test hooks (env vars, set by the test before calling the handler):
//   DESIGN_AGENT_TEST_WORKSPACE_LOG  -> written with the workspace dir path
//   DESIGN_AGENT_TEST_CONTAINER_LOG  -> written with the fake container id
// Both are written while still "in flight" so a test can later assert the
// workspace dir / container are gone once the handler has returned.
import fs from 'node:fs';
import crypto from 'node:crypto';

export function runFakeTask(mode) {
  const [, , workspaceDir] = process.argv;
  const containerId = `fake-container-${crypto.randomUUID()}`;

  if (workspaceDir) {
    console.log(`WORKSPACE_DIR_SEEN: ${workspaceDir}`);
    console.log(`WORKSPACE_HAS_FIXTURE: ${fs.existsSync(`${workspaceDir}/index.html`)}`);
    if (process.env.DESIGN_AGENT_TEST_WORKSPACE_LOG) {
      fs.writeFileSync(process.env.DESIGN_AGENT_TEST_WORKSPACE_LOG, workspaceDir);
    }
  }

  if (mode === 'no-container') {
    // Simulates a crash before the Docker workspace even started (e.g. a
    // Python import error) — no CONTAINER line at all, nothing for the
    // backstop to clean up.
    process.exitCode = 1;
    return;
  }

  console.log(`DESIGN_AGENT_CONTAINER: ${JSON.stringify({ container_id: containerId })}`);
  if (process.env.DESIGN_AGENT_TEST_CONTAINER_LOG) {
    fs.writeFileSync(process.env.DESIGN_AGENT_TEST_CONTAINER_LOG, containerId);
  }

  if (mode === 'crash') {
    // Container exists, but the process dies before producing a result line
    // — the scenario the Node-side backstop `docker rm -f` exists for.
    process.exitCode = 1;
    return;
  }

  if (mode === 'fail') {
    console.log('DESIGN_AGENT_RESULT: ' + JSON.stringify({ status: 'error', detail: 'stub: task failed on purpose' }));
    process.exitCode = 1;
    return;
  }

  if (mode === 'hang-honor-sigterm') {
    // Mirrors design_task.py's real _Terminated path: on SIGTERM, print an
    // error result line (as if its own `with DockerWorkspace(...)` cleanup
    // just ran) and exit — proves a single SIGTERM is enough, no SIGKILL
    // escalation needed.
    process.on('SIGTERM', () => {
      console.log('DESIGN_AGENT_RESULT: ' + JSON.stringify({ status: 'error', detail: 'terminated by signal SIGTERM' }));
      process.exit(1);
    });
    setInterval(() => {}, 1000); // keep the event loop alive until SIGTERM or a test-imposed SIGKILL
    return;
  }

  if (mode === 'hang-ignore-sigterm') {
    // Explicitly swallows SIGTERM (Node's default behavior would otherwise
    // still exit on it) so only SIGKILL can end this process — proves the
    // handler's SIGTERM -> grace period -> SIGKILL escalation actually works.
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    return;
  }

  console.log('DESIGN_AGENT_RESULT: ' + JSON.stringify({ status: 'ok', detail: 'stub: task completed' }));
  process.exitCode = 0;
}
