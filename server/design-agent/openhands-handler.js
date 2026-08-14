import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { getSiteById } from '../store/read.js';
import { UserFacingError } from '../lib/errors.js';
import { checkoutRepoTarball } from './repo-checkout.js';
import { findRelevantMemory } from '../agent-memory.js';

// Shared generatorId in agent_fix_memory (097) for every Design Agent
// component-templates write/read — this module's own RETRIEVE lookup below
// and design-drift.js's LEARN write (resolveOrCreateComponentTemplate, the
// sole autonomous path that creates or verifies a componentTemplate) both
// tag/filter by this same id, so there is exactly one learning history per
// site.
export const DESIGN_AGENT_GENERATOR_ID = 'design-agent-component-templates';

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
function runDesignTaskProcess({ pythonBin, scriptPath, workspaceDir, extraArgs, env, timeoutMs, killGraceMs, onContainerId }) {
  return new Promise((resolve) => {
    const child = spawn(pythonBin, [scriptPath, workspaceDir, ...extraArgs], { env });

    let result = null;
    let containerId = null;
    let stderrTail = '';
    let timedOut = false;
    let killTimer = null;
    let graceTimer = null;
    let spawnError = null;

    // A spawn failure (missing/unexecutable interpreter — ENOENT/EACCES)
    // emits 'error', NOT a non-zero exit. Without this listener that event is
    // unhandled, which throws out of band and reaches the job row as the
    // generic "failed unexpectedly" with the real reason existing nowhere a
    // reader can reach. Captured here so it travels back through the normal
    // resolve path and the caller can name the actual stage that broke.
    child.on('error', (err) => {
      spawnError = err;
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
    });

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

    // 'close' still fires after 'error' in the spawn-failure case, so this
    // stays the single resolve point for both paths.
    child.on('close', (code) => {
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      rl.close();
      resolve({ result, containerId, code, timedOut, stderrTail, spawnError });
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
// pythonBin/scriptPath/dockerBin are all injectable specifically so tests
// can swap in stubs for the whole Python+Docker boundary (see test-support/)
// without ever touching a real Python interpreter, the real OpenHands SDK,
// or a real `docker` binary.
//
// workspaceSource(destDir, job) populates destDir (already created, via
// mkdtemp) before the task runs — defaults to copying `fixtureDir` (Step
// 6D's fixture-demo path; `fixtureDir` itself defaults to the checked-in
// test fixture and stays a supported shorthand for the common "just copy a
// directory" case — server/design-agent/openhands-handler.test.js's stubs
// still use it). buildArgs(job) returns extra argv passed to design_task.py
// after the workspace dir — defaults to none (fixture-demo mode).
// createComponentTemplateHandler below is the other concrete instantiation:
// real repo checkout + component-templates mode, same underlying
// spawn/timeout/cleanup machinery.
export function createOpenHandsHandler({
  pythonBin = process.env.DESIGN_AGENT_PYTHON_BIN || DEFAULT_PYTHON_BIN,
  scriptPath = DEFAULT_SCRIPT_PATH,
  fixtureDir = DEFAULT_FIXTURE_DIR,
  workspaceSource = (destDir) => cp(fixtureDir, destDir, { recursive: true }),
  buildArgs = () => [],
  dockerBin = process.env.DESIGN_AGENT_DOCKER_BIN || 'docker',
  timeoutMs = Number(process.env.DESIGN_AGENT_TASK_TIMEOUT_MS || 10 * 60 * 1000),
  killGraceMs = Number(process.env.DESIGN_AGENT_KILL_GRACE_MS || 5000),
} = {}) {
  return async function openHandsHandler(job) {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'design-agent-'));
    let containerId = null;
    try {
      // Naming this stage matters more than the others: it is the first thing
      // that touches the network (a GitHub tarball of the tenant's repo for the
      // real handlers), so a revoked or expired PAT surfaces here — and did so
      // indistinguishably from every other failure before this.
      try {
        await workspaceSource(workspaceDir, job);
      } catch (err) {
        // `stage` is what lib/failure-classification.js classifies on — set
        // at the boundary that actually threw, never inferred later from
        // message text.
        const wrapped = new UserFacingError("The Design Agent could not fetch this site's repository. Check that the site's GitHub token is valid and still has access to the configured repo.", { cause: err });
        wrapped.stage = 'repo_checkout';
        wrapped.code = err?.code || null;
        throw wrapped;
      }

      const env = {
        ...process.env,
        LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
        LLM_API_KEY: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
        LLM_BASE_URL: process.env.LLM_BASE_URL || '',
        OPENHANDS_SUPPRESS_BANNER: '1',
      };

      const { result, code, timedOut, stderrTail, spawnError } = await runDesignTaskProcess({
        pythonBin, scriptPath, workspaceDir, extraArgs: await buildArgs(job), env, timeoutMs, killGraceMs,
        onContainerId: (id) => { containerId = id; },
      });

      // Named before the generic no-result case below: this is an environment
      // fault (the analysis never started), not an analysis that failed, and
      // it is the one failure whose fix is purely operational.
      if (spawnError) {
        const wrapped = new UserFacingError(`The Design Agent could not start its analysis process (${spawnError.code || 'spawn failed'}). Its Python environment is missing or not executable in this deployment — this needs an engineer, it will not resolve on its own.`, { cause: spawnError });
        wrapped.stage = 'python_startup';
        wrapped.code = spawnError.code || null;
        throw wrapped;
      }

      if (timedOut) {
        // Stage-naming, deliberately free of interpolated exception text so it
        // is safe to persist and show — worker.js surfaces UserFacingError
        // messages onto the job row, which is the only place an operator can
        // read them without shelling into the container.
        const wrapped = new UserFacingError(`The Design Agent ran for ${Math.round(timeoutMs / 1000)}s without finishing and was stopped. The site's repository analysis is taking longer than the configured limit.`);
        wrapped.stage = 'agent_run';
        wrapped.timedOut = true;
        throw wrapped;
      }
      if (!result) {
        // The exit code is safe to name; stderrTail is NOT — it can carry
        // tokens, hostnames and provider errors — so it stays in the internal
        // log only, reachable via the correlation id worker.js records.
        const wrapped = new UserFacingError(`The Design Agent's analysis process exited (code ${code}) without producing a result. This usually means its container or Python environment could not start — see the worker logs for this job's reference id.`, { cause: new Error(`stderr: ${stderrTail || '(empty)'}`) });
        wrapped.stage = 'agent_run';
        wrapped.exitCode = code;
        throw wrapped;
      }
      if (result.status !== 'ok') {
        // result.detail is the Python task's own structured message, not a raw
        // exception, so naming the stage is safe; the detail itself still goes
        // to the internal log rather than the job row.
        // An ENVIRONMENT_* errorClass means the analysis never actually ran —
        // the host lacked Docker or model credentials. That is a deployment
        // fault, not the agent reasoning badly, so it must not be reported as
        // an agent-logic failure (which is non-recoverable and points the
        // reader at the wrong fix). design_task.py emits this as a closed
        // vocabulary; anything unrecognized keeps the old behaviour.
        const isEnvironment = typeof result.errorClass === 'string' && result.errorClass.startsWith('ENVIRONMENT_');
        const wrapped = new UserFacingError(
          isEnvironment
            ? 'The Design Agent could not run: its analysis sandbox is unavailable in this deployment (Docker or model credentials). This needs an engineer — it will not resolve on its own.'
            : "The Design Agent finished but reported that it could not analyse this site's repository.",
          { cause: new Error(`OpenHands detail: ${result.detail || 'unknown error'}`) }
        );
        wrapped.stage = isEnvironment ? 'python_environment' : 'result_validation';
        throw wrapped;
      }
      return { jobId: job.id, detail: result.detail, componentTemplates: result.componentTemplates };
    } finally {
      await backstopDockerCleanup(dockerBin, containerId);
      await rm(workspaceDir, { recursive: true, force: true });
    }
  };
}

// componentTemplates integration: real repo checkout (repo-checkout.js)
// instead of the fixture copy, "component-templates" task mode instead of
// fixture-demo, componentKeys carried on the job's own `params` (090,
// store/execution-jobs.js's createComponentTemplateJob). Everything else —
// spawn/stdout-parsing/timeout/SIGKILL-escalation/backstop cleanup — is the
// exact same createOpenHandsHandler machinery above, just parameterized
// differently.
// getSiteByIdFn/checkoutRepoTarballFn/findRelevantMemoryFn are injectable
// (default to the real store/read.js, repo-checkout.js, and
// agent-memory.js implementations) so tests can stub the DB lookup, the
// real GitHub tarball download, and the memory lookup independently, same
// dependency-injection convention as pythonBin/scriptPath/dockerBin above.
export function createComponentTemplateHandler({
  getSiteByIdFn = getSiteById, checkoutRepoTarballFn = checkoutRepoTarball, findRelevantMemoryFn = findRelevantMemory, ...options
} = {}) {
  return createOpenHandsHandler({
    ...options,
    workspaceSource: async (destDir, job) => {
      const site = await getSiteByIdFn(job.site_id);
      await checkoutRepoTarballFn(site, destDir);
    },
    // RETRIEVE — same shape as withAgentMemory (agent-memory.js): scope:
    // 'client', clientFacing: true (category='code' rows structurally
    // unreachable), no category filter, so any past design-agent lesson
    // recorded by design-drift.js's LEARN write surfaces here. Never lets a
    // memory-table failure block the job — same defensive no-op-on-error
    // convention withAgentMemory itself uses.
    buildArgs: async (job) => {
      const lessons = await findRelevantMemoryFn({
        scope: 'client', siteId: job.site_id, generatorId: DESIGN_AGENT_GENERATOR_ID, clientFacing: true, limit: 5,
      }).catch((err) => {
        console.warn(`[design-agent] memory lookup failed for site ${job.site_id}, continuing without it: ${err.message}`);
        return [];
      });
      const lessonsForPrompt = lessons.map((l) => ({
        symptoms: l.symptoms,
        rootCause: l.rootCause,
        fixPattern: l.executionPermission === 'auto' ? l.fixPattern : null,
      }));
      return ['component-templates', JSON.stringify(job.params?.componentKeys || []), JSON.stringify(lessonsForPrompt)];
    },
  });
}

// Website-level design derivation — the SOURCE every per-component template
// is projected from (design-agent/lib/design-profile.js).
//
// Same machinery as createComponentTemplateHandler above (real repo checkout,
// read-only analysis, memory-augmented prompt), differing only in mode and in
// taking no action-type list: there is nothing to scope it to, because the
// whole site is the scope. That is the architectural point — one analysis per
// site instead of one per content type, so a new design-sensitive generator
// needs no new repo analysis at all.
export function createDesignProfileHandler({
  getSiteByIdFn = getSiteById, checkoutRepoTarballFn = checkoutRepoTarball, findRelevantMemoryFn = findRelevantMemory, ...options
} = {}) {
  return createOpenHandsHandler({
    ...options,
    workspaceSource: async (destDir, job) => {
      const site = await getSiteByIdFn(job.site_id);
      await checkoutRepoTarballFn(site, destDir);
    },
    buildArgs: async (job) => {
      const lessons = await findRelevantMemoryFn({
        scope: 'client', siteId: job.site_id, generatorId: DESIGN_AGENT_GENERATOR_ID, clientFacing: true, limit: 5,
      }).catch((err) => {
        console.warn(`[design-agent] memory lookup failed for site ${job.site_id}, continuing without it: ${err.message}`);
        return [];
      });
      const lessonsForPrompt = lessons.map((l) => ({
        symptoms: l.symptoms,
        rootCause: l.rootCause,
        fixPattern: l.executionPermission === 'auto' ? l.fixPattern : null,
      }));
      // argv[3] is a placeholder so the argument positions stay identical to
      // component-templates mode — the Python side ignores it for this mode.
      return ['design-profile', '[]', JSON.stringify(lessonsForPrompt)];
    },
  });
}

// The worker (worker.js's main()) claims ANY kind='design_generate' job
// regardless of what it's for — this is the single dispatch point that
// routes each claimed job to the right handler based on job.params.mode, so
// the worker's poll loop itself never needs to know how many kinds of
// design_generate job exist. In production, the only source of these jobs
// is component-templates mode via resolveOrCreateComponentTemplate's
// synchronous handler call (never queued through execution_jobs at all —
// see that function). The fixture-demo fallback (no params.mode) exists for
// the dev-only verify-design-agent-docker.js/verify-component-templates-
// real-repo.js scripts that exercise this queue+worker machinery directly.
export function createDesignAgentHandler(options = {}) {
  const fixtureDemoHandler = createOpenHandsHandler(options);
  const componentTemplateHandler = createComponentTemplateHandler(options);
  const designProfileHandler = createDesignProfileHandler(options);
  return async function dispatchingHandler(job) {
    if (job.params?.mode === 'design-profile') return designProfileHandler(job);
    if (job.params?.mode === 'component-templates') return componentTemplateHandler(job);
    return fixtureDemoHandler(job);
  };
}
