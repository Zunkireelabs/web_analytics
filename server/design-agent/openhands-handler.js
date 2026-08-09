import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PYTHON_BIN = join(here, 'python', '.venv', 'bin', 'python3');
const DEFAULT_SCRIPT_PATH = join(here, 'python', 'design_task.py');
const DEFAULT_FIXTURE_DIR = join(here, 'fixtures', 'test-site');
const RESULT_PREFIX = 'DESIGN_AGENT_RESULT: ';
const CONTAINER_PREFIX = 'DESIGN_AGENT_CONTAINER: ';

function parseJsonAfterPrefix(line, prefix) {
  if (!line.startsWith(prefix)) return null;
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
}

// Runs design_task.py as a child process, watching its stdout line-by-line
// (not just buffering to the end, unlike Step 6C) so containerId is known
// the moment the Docker workspace boundary reports it — that's what lets
// the caller run a `docker rm -f` backstop even if the process is later
// killed outright and never reaches its own final result line.
//
// Resolves { result, containerId } once the child exits — `result` is
// whatever the final RESULT_PREFIX line parsed to, or null if the process
// never produced one (crash/kill before that point). Never rejects on a
// non-zero exit by itself; the caller decides what a bad exit code means.
function runDesignTaskProcess({ pythonBin, scriptPath, workspaceDir, env, timeoutMs, killGraceMs, onContainerId }) {
  return new Promise((resolve) => {
    const child = spawn(pythonBin, [scriptPath, workspaceDir], { env });

    let result = null;
    let containerId = null;
    let stderrTail = '';
    let timedOut = false;
    let killTimer = null;
    let graceTimer = null;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const containerMsg = parseJsonAfterPrefix(line, CONTAINER_PREFIX);
      if (containerMsg?.container_id) {
        containerId = containerMsg.container_id;
        if (onContainerId) onContainerId(containerId);
        return;
      }
      const resultMsg = parseJsonAfterPrefix(line, RESULT_PREFIX);
      if (resultMsg) result = resultMsg;
    });

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    if (timeoutMs) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM'); // design_task.py's SIGTERM handler cleans up its DockerWorkspace before exiting
        graceTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs); // backstop if it ignores/can't honor SIGTERM in time
      }, timeoutMs);
    }

    child.on('close', (code) => {
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      rl.close();
      resolve({ result, containerId, code, timedOut, stderrTail });
    });
  });
}

// Best-effort backstop: `docker rm -f` the container regardless of whether
// design_task.py's own DockerWorkspace.cleanup() already removed it (that
// path stops+removes on any normal exception AND on the SIGTERM-to-
// _Terminated path — see that file). This only matters when the child was
// killed too abruptly for its own cleanup to run (e.g. SIGKILL escalation).
// Idempotent (removing an already-gone container is a no-op failure we
// swallow) and never allowed to mask the job's real outcome.
async function backstopDockerCleanup(dockerBin, containerId) {
  if (!containerId) return;
  try {
    await execFileAsync(dockerBin, ['rm', '-f', containerId], { timeout: 15_000 });
  } catch (err) {
    console.error(`[design-agent] backstop docker cleanup for ${containerId} failed (may already be gone):`, err.message);
  }
}

// Builds a handler compatible with worker.js's processOneJob({ handler }):
// an async (job) => {...} that throws on failure, resolves on success.
//
// Isolation boundary (Step 6D): each call gets its own throwaway host temp
// directory (copy of the checked-in fixture, never the fixture itself) AND,
// inside design_task.py, its own throwaway Docker container bind-mounted to
// that directory — no two concurrent jobs ever share a host directory or a
// container. Both are always cleaned up — success, failure, timeout, or the
// worker process being asked to shut down mid-job (that just means this
// promise is still in flight when worker.stop() awaits it; this function's
// own try/finally runs exactly the same regardless of who's waiting on it).
//
// pythonBin/scriptPath/fixtureDir/dockerBin are all injectable specifically
// so tests can swap in stubs for the whole Python+Docker boundary (see
// test-support/) without ever touching a real Python interpreter, the real
// OpenHands SDK, or a real `docker` binary.
export function createOpenHandsHandler({
  pythonBin = process.env.DESIGN_AGENT_PYTHON_BIN || DEFAULT_PYTHON_BIN,
  scriptPath = DEFAULT_SCRIPT_PATH,
  fixtureDir = DEFAULT_FIXTURE_DIR,
  dockerBin = process.env.DESIGN_AGENT_DOCKER_BIN || 'docker',
  timeoutMs = Number(process.env.DESIGN_AGENT_TASK_TIMEOUT_MS || 10 * 60 * 1000),
  killGraceMs = Number(process.env.DESIGN_AGENT_KILL_GRACE_MS || 5000),
} = {}) {
  return async function openHandsHandler(job) {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'design-agent-'));
    let containerId = null;
    try {
      await cp(fixtureDir, workspaceDir, { recursive: true });

      const env = {
        ...process.env,
        LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
        LLM_API_KEY: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
        LLM_BASE_URL: process.env.LLM_BASE_URL || '',
        OPENHANDS_SUPPRESS_BANNER: '1',
      };

      const { result, code, timedOut, stderrTail } = await runDesignTaskProcess({
        pythonBin, scriptPath, workspaceDir, env, timeoutMs, killGraceMs,
        onContainerId: (id) => { containerId = id; },
      });

      if (timedOut) {
        throw new Error(`OpenHands task timed out after ${timeoutMs}ms and was terminated`);
      }
      if (!result) {
        throw new Error(`OpenHands task failed: process exited (code ${code}) with no result line${stderrTail ? ` — stderr: ${stderrTail}` : ''}`);
      }
      if (result.status !== 'ok') {
        throw new Error(`OpenHands task failed: ${result.detail || 'unknown error'}`);
      }
      return { jobId: job.id, detail: result.detail };
    } finally {
      await backstopDockerCleanup(dockerBin, containerId);
      await rm(workspaceDir, { recursive: true, force: true });
    }
  };
}
