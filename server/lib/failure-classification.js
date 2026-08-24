// Why an autonomous agent job failed, in a form both a human and the system
// itself can act on. Extends lib/errors.js (which decides how much of a
// failure is SAFE TO SHOW); this module decides WHAT KIND of failure it was
// and WHO can fix it. The two are deliberately separate concerns: a
// deployment fault and an invalid-input fault can carry the same
// customer-safe text while needing completely different responses.
//
// This exists because every design_generate job that failed before it
// recorded exactly one thing — "Design Agent job failed unexpectedly" —
// which is indistinguishable between "retry in 30s and it works", "this
// client's repo is broken", and "the container has no Python". Job 3008 on
// site 1 sat in that state for over a day precisely because nothing could
// tell those apart without shelling into a container.

// The classes are a closed set on purpose: an open-ended string field would
// re-create the same "every failure looks alike" problem one level up.
export const FAILURE_CLASS = {
  // The agent's own reasoning/output was wrong (bad template, unusable
  // profile, malformed result). Ours to fix in code — never retryable,
  // since the same input will produce the same wrong output.
  AGENT_LOGIC: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG',
  // The job's inputs don't describe something actionable (missing params,
  // a page that isn't mapped). Ours to fix in config/data, not by retrying.
  INVALID_INPUT: 'FAILED_BECAUSE_INPUT_IS_INVALID',
  // The tenant's repository is unreachable/unusable — revoked token, repo
  // deleted, branch missing. The CLIENT (or their admin) must act; retrying
  // cannot help.
  CLIENT_REPO: 'FAILED_BECAUSE_CLIENT_REPOSITORY_IS_BROKEN',
  // Our own runtime is not what the code requires — missing interpreter,
  // absent Docker socket, unbuilt venv. No amount of retrying fixes it; an
  // engineer must change the deployment. This is the class that must NEVER
  // be reported as "queued, will resolve on its own".
  DEPLOYMENT: 'FAILED_BECAUSE_DEPLOYMENT_IS_BROKEN',
  // A third party (GitHub, the model provider, the network) was down or
  // rate-limited. Genuinely transient — the one class where an automatic
  // retry is both safe and likely to succeed.
  EXTERNAL_SERVICE: 'FAILED_BECAUSE_EXTERNAL_SERVICE_IS_UNAVAILABLE',
  // The agent correctly declined to act. Not a malfunction: a safety gate
  // firing is the system working. Never retried, never auto-escalated.
  UNSAFE: 'FAILED_BECAUSE_ACTION_IS_UNSAFE',
};

// Only EXTERNAL_SERVICE is auto-retryable. Every other class either cannot
// be helped by a retry (deployment, repo, unsafe) or would produce an
// identical wrong result (agent logic, invalid input) — retrying those
// burns model spend and hides the real fault behind attempt counts, which
// is how a broken deployment stayed invisible for a day.
const RETRYABLE = new Set([FAILURE_CLASS.EXTERNAL_SERVICE]);

// Which side of the app/infra line a class falls on. Drives the honest
// distinction the Action Center needs: "the system is working on it" vs
// "this needs a human with deploy access and will not resolve itself".
const INFRASTRUCTURE = new Set([FAILURE_CLASS.DEPLOYMENT, FAILURE_CLASS.EXTERNAL_SERVICE]);

// Deterministic signal -> class. Ordered most-specific first; each rule is
// keyed off a real, observed failure mode rather than free-text matching on
// a message, because provider message wording changes without notice.
//
// `stage` is the pipeline step that threw (the caller names it — e.g.
// 'python_startup', 'repo_checkout'), NOT a guess derived from the error.
const SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM']);
const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

export function classifyFailure({ stage, err, exitCode, timedOut } = {}) {
  const code = err?.code || null;

  // A failed spawn at the interpreter/binary boundary is definitionally our
  // deployment: the code asked for an executable this environment doesn't
  // have. This is the exact ENOENT that stalled every design-profile job.
  if (stage === 'python_startup' || SPAWN_CODES.has(code)) {
    return build(FAILURE_CLASS.DEPLOYMENT, 'PYTHON_EXECUTABLE_MISSING', stage || 'python_startup',
      'The configured Python executable could not be started in this environment.', err);
  }

  // Python started, but its sandbox/credentials were absent — the analysis
  // never ran. Deployment, not agent logic (see design_task.py's ENVIRONMENT_*
  // codes); misclassifying this points the reader at the wrong fix entirely.
  //
  // design_task.py already tells the three of these apart (Docker itself
  // unreachable, the model API key rejected, or the sandbox container
  // crashed mid-run after starting) — carried here via err.pythonErrorClass
  // rather than collapsed into one generic code, since each needs a
  // different fix and conflating them is what made two real staging
  // failures (jobs 628/1091) indistinguishable after the fact. Any
  // ENVIRONMENT_* value this doesn't recognize (a future Python-side
  // addition) falls back to the original generic code/message rather than
  // guessing — never silently mapped to the wrong specific one.
  if (stage === 'python_environment') {
    const SANDBOX_SUBCLASS = {
      ENVIRONMENT_DOCKER_UNAVAILABLE: {
        errorCode: 'AGENT_SANDBOX_DOCKER_UNAVAILABLE',
        message: "The agent's analysis sandbox could not reach Docker in this environment.",
      },
      ENVIRONMENT_MODEL_AUTH: {
        errorCode: 'AGENT_SANDBOX_MODEL_AUTH_FAILED',
        message: "The agent's model credentials were rejected in this environment.",
      },
      ENVIRONMENT_CONTAINER_CRASHED: {
        errorCode: 'AGENT_SANDBOX_CONTAINER_CRASHED',
        message: "The agent's analysis sandbox container stopped unexpectedly mid-run.",
      },
    };
    const sub = SANDBOX_SUBCLASS[err?.pythonErrorClass] || null;
    const built = build(FAILURE_CLASS.DEPLOYMENT, sub?.errorCode || 'AGENT_SANDBOX_UNAVAILABLE', stage,
      sub?.message || "The agent's analysis sandbox (Docker) or model credentials are unavailable in this environment.", err);
    // Internal-only — a docker-inspect/docker-logs snapshot can carry
    // container output verbatim (a stray printed token, a repo URL). Never
    // added to design-agent-status.js's publicFailure() allowlist, which is
    // the one place this object's fields reach a customer-facing message —
    // this key existing at all is what an engineer queries execution_jobs
    // for; it is not meant to flow anywhere else.
    if (err?.containerDiagnostics) built.diagnostics = sanitizeContainerDiagnostics(err.containerDiagnostics);
    return built;
  }

  if (stage === 'repo_checkout') {
    // A network fault reaching GitHub is the provider's; anything else at
    // this stage (auth rejected, repo gone) is the tenant's repo config.
    return TRANSIENT_CODES.has(code)
      ? build(FAILURE_CLASS.EXTERNAL_SERVICE, 'REPO_FETCH_UNAVAILABLE', stage,
        'The repository host could not be reached.', err)
      : build(FAILURE_CLASS.CLIENT_REPO, 'REPO_INACCESSIBLE', stage,
        "This site's repository could not be read — its access token or repo configuration is no longer valid.", err);
  }

  if (timedOut) {
    return build(FAILURE_CLASS.EXTERNAL_SERVICE, 'AGENT_RUN_TIMEOUT', stage || 'agent_run',
      'The analysis exceeded its time limit before producing a result.', err);
  }

  if (TRANSIENT_CODES.has(code)) {
    return build(FAILURE_CLASS.EXTERNAL_SERVICE, 'UPSTREAM_UNAVAILABLE', stage || 'unknown',
      'An external service was unreachable.', err);
  }

  // Exited without a parseable result: the process ran but its environment
  // or dependencies were incomplete (the container couldn't start, an import
  // failed). Distinct from a spawn failure — Python DID start here.
  if (exitCode != null && exitCode !== 0) {
    return build(FAILURE_CLASS.DEPLOYMENT, 'AGENT_PROCESS_EXITED', stage || 'agent_run',
      `The analysis process exited (code ${exitCode}) without producing a result.`, err);
  }

  if (stage === 'result_validation') {
    return build(FAILURE_CLASS.AGENT_LOGIC, 'AGENT_RESULT_UNUSABLE', stage,
      'The agent returned a result that failed validation and was rejected rather than saved.', err);
  }

  if (stage === 'input_validation') {
    return build(FAILURE_CLASS.INVALID_INPUT, 'JOB_INPUT_INVALID', stage,
      "This job's inputs do not describe an actionable change.", err);
  }

  // Deliberately NOT defaulted to a benign class: an unrecognized failure is
  // treated as ours to investigate, so a new failure mode surfaces loudly
  // instead of being silently absorbed as "probably transient".
  return build(FAILURE_CLASS.AGENT_LOGIC, 'UNCLASSIFIED_FAILURE', stage || 'unknown',
    'The job failed for a reason the system does not yet recognise.', err);
}

function build(failureClass, errorCode, stage, message, err) {
  return {
    failureClass,
    errorCode,
    stage,
    message,
    recoverable: RETRYABLE.has(failureClass),
    infrastructure: INFRASTRUCTURE.has(failureClass),
    // The raw cause is NEVER included here — callers log it via
    // lib/errors.js's safeMessage/logInternal and persist only this object,
    // so a provider's error body can't reach a job row a customer can read.
    causeCode: err?.code || null,
  };
}

// Structural allowlist over design_task.py's _capture_container_diagnostics
// output — defense in depth on top of that function's own 4000-char cap on
// logsTail, so a future Python-side field this module doesn't yet know
// about is dropped by default rather than passed through unexamined.
// `logsTail` is real container stdout/stderr and can in principle carry
// anything the container printed; it stays in the returned object (this is
// the internal diagnostic value the whole exercise exists to preserve) but
// is never added to design-agent-status.js's publicFailure() allowlist —
// that boundary, not this one, is what keeps it off any customer-facing
// surface.
function sanitizeContainerDiagnostics(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { exitCode, oomKilled, status, stateError, inspectError, logsError, logsTail } = raw;
  const out = {};
  if (exitCode !== undefined) out.exitCode = exitCode;
  if (oomKilled !== undefined) out.oomKilled = oomKilled;
  if (status !== undefined) out.status = status;
  if (typeof stateError === 'string') out.stateError = stateError.slice(0, 500);
  if (typeof inspectError === 'string') out.inspectError = inspectError.slice(0, 500);
  if (typeof logsError === 'string') out.logsError = logsError.slice(0, 500);
  if (typeof logsTail === 'string') out.logsTail = logsTail.slice(-4000);
  return out;
}

// True only when an automatic retry is both safe and plausibly useful.
// `attempt` is 1-based. Capped low on purpose: retries are a recovery
// mechanism, not a way to wait out a fault that needs a human.
export function shouldRetry(classification, attempt, maxAttempts = 3) {
  return !!classification?.recoverable && attempt < maxAttempts;
}
