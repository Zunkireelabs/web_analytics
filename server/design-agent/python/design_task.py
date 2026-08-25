"""The real OpenHands Agent + Conversation call, run inside an isolated
DockerWorkspace container — one per job, never shared. Invoked as a
subprocess by server/design-agent/openhands-handler.js — same Node-spawns-
Python bridge already used for agents/clustering.py (see server/cron.js),
and the same LLM/Agent/Conversation shape validated in design-agent-poc's
run_poc.py (Step 1).

Three modes, chosen by argv[2] (default "fixture-demo" — matches every
existing call site/test that only ever passes argv[1]):

- "fixture-demo" (Step 6D): runs against argv[1], a throwaway temp-directory
  COPY of the checked-in fixture (server/design-agent/fixtures/test-site) —
  never a real tenant repository. Fixed, minimal, file-editing task (add one
  small section to one page, reusing existing styles). Unchanged from 6D —
  this is what server/design-agent/*.test.js exercises via stubs, and what
  server/scripts/verify-design-agent-docker.js exercises for real.

- "component-templates": runs against argv[1], a real checkout of a
  tenant's actual repo (server/design-agent/repo-checkout.js, bind-mounted
  the same way the fixture copy is). Read-only analysis, not editing — given
  argv[3], a JSON array of design-drift.js/marker-merge.js action-type
  strings (e.g. ["faq", "expand-content"]), inspects the real repo and
  derives a {wrapper, row} HTML template per requested type, using only
  classes/markup patterns actually present in real source files. Optional
  argv[4] is a JSON array of agent_fix_memory rows (server/agent-memory.js's
  findRelevantMemory, looked up by openhands-handler.js before spawning this
  process — see openhands-handler.js's DESIGN_AGENT_GENERATOR_ID) appended
  to the task as advisory "known issues" text — the same RETRIEVE step
  every other generator gets via server/llm.js's withAgentMemory, wired in
  here since this generator's LLM call never goes through callLLM. The
  derived templates are the deliverable, not any file edit — captured from
  the agent's own final message (conversation.state.events, same technique
  design-agent-poc/run_poc_step4.py validated for extracting a design
  profile) rather than a file on disk, and reported as a
  `componentTemplates` field on the final result line. Still re-validated,
  not trusted blind: the Node/JS side
  (server/implementers/lib/design-drift.js's resolveOrCreateComponentTemplate)
  re-checks every entry against the exact same placeholder contract before
  ever saving it — no human review step anywhere in this path, by design.

- "design-profile": also runs against a real tenant repo checkout, also
  read-only. Derives the site's WHOLE design language once — typography,
  colour, spacing, layout, component conventions (cards, buttons, accordions,
  lists, article body), responsive breakpoints — reported on the final result
  line as `designProfile`. This is the SOURCE the Node side projects every
  per-component template from (design-agent/lib/design-profile.js), which is
  why it does not take an action-type list: the whole site is the scope. It
  replaces the need to re-analyse the repo once per content type, and is what
  stops each design-sensitive generator inventing its own presentation.

- "code-self-repair" (server/agents/lib/code-self-repair.js): runs against
  argv[1], a real checkout of THIS platform's OWN repository (not a client
  site — server/design-agent/openhands-handler.js's
  createCodeSelfRepairHandler, checked out the same way a tenant repo is,
  via repo-checkout.js against a platform-repo descriptor instead of a
  `site` row), on `stage`. Unlike the two modes above, this one EDITS real
  files: argv[3] is a JSON object {generatorId, reason, errorMessage,
  occurrenceDays, testFileHint} describing a generator/implementer bug that
  has now failed identically on at least two separate calendar days across
  real sites (server/agents/lib/auto-remediation.js's escalation sweep) —
  investigate the real root cause, make the smallest safe fix, and validate
  it. The agent's own TerminalTool test run is advisory only; this script
  independently re-validates every changed file after the agent's turn ends
  (node --check for syntax, node --test for the given/inferred test file) —
  see _validate_code_self_repair below — and only reports status:"ok" when
  that independent check actually passes. `patch` (a unified diff) and
  `filesChanged` (each file's real new content, since the workspace is
  deleted right after this process exits) are what the Node side turns into
  a real branch + PR; nothing here ever commits, pushes, or opens a PR
  itself — this process only edits files on disk and validates.

- "capability-repair" (server/agents/lib/template-capability-repair.js):
  runs against argv[1], a real checkout of a TENANT'S own repo (same
  workspaceSource as component-templates/design-profile mode — NOT the
  platform's own repo like code-self-repair above). The one case
  classifyCapabilityGap (template-capability-repair.js) calls
  'architectural-gap': a recommendation type has no rendering slot on its
  own template, and no sibling route sharing the same data file in this
  site already solved it, so there is no existing pattern in this site's
  own config to clone. argv[3] is a JSON object {generatorId, valueKey,
  templatePath, templateSource, dataFilePath, dataFileSource,
  conventionExamples} — every field real evidence gathered by the Node
  side, never invented here. Like code-self-repair, this EDITS real
  files (the one template + one data file named in the payload, and
  nothing else — enforced structurally, see _snapshot_specific_files/
  _validate_capability_repair below) to add the smallest new data field
  + template rendering slot, then validates independently by running the
  TENANT'S OWN build command (read from ITS OWN package.json — never
  npm/yarn/pnpm assumed, never any repo-specific command hardcoded).
  Generic across every tenant/data-shape/template-system by construction:
  nothing in this mode's prompt or validation logic names a specific
  site, field, or generator — those all come from `payload`.

Prints two kinds of sentinel lines the Node handler looks for:
- CONTAINER_PREFIX, as soon as the container exists — captured eagerly (the
  handler reads stdout line-by-line, not just at the end) so it still knows
  the container id even if this process is later killed outright and never
  reaches the final result line, and can issue its own `docker rm -f` as a
  backstop.
- RESULT_PREFIX, exactly once, at the end: {"status": "ok"|"error", ...},
  plus {"componentTemplates": {...}} for the component-templates mode. An
  error result may also carry `errorClass` (closed vocabulary, see the
  ENVIRONMENT_* handling below) and, when the sandbox container died mid-run,
  `containerDiagnostics` (docker inspect's exit code/OOM flag + a `docker
  logs` tail, captured before cleanup removes the container — see
  _capture_container_diagnostics / _ContainerRunError).
Everything else on stdout/stderr is the SDK's own logging (it even prints a
banner on import) and is ignored by the caller, but still visible if this
script is run by hand for debugging.

SIGTERM handling: Node's execFile timeout (and its own SIGTERM/SIGKILL
escalation) sends SIGTERM first. Python's default SIGTERM behavior does NOT
run `with`-block cleanup, so a killed process would otherwise leak its
container. The handler below installs a SIGTERM handler that raises
SystemExit from inside the `with DockerWorkspace(...)` block instead, so its
__exit__ (-> cleanup() -> `docker stop`, which also removes it since `--rm`
was used at `docker run` time) still runs before the process actually exits.
"""

import difflib
import json
import os
import re
import signal
import subprocess
import sys
import time

RESULT_PREFIX = "DESIGN_AGENT_RESULT: "
CONTAINER_PREFIX = "DESIGN_AGENT_CONTAINER: "
DOCKER_IMAGE = os.getenv("DESIGN_AGENT_DOCKER_IMAGE", "ghcr.io/openhands/agent-server:latest-python")

# This process itself normally runs inside a container (design-agent-worker)
# that only has the host's Docker socket mounted, not --network host. It then
# asks that socket to start a *sibling* container and publish a port for it.
# DockerWorkspace defaults its health-check/API host to 127.0.0.1, which is
# this process's own loopback — a different network namespace from the one
# `docker run -p` actually publishes the sibling's port on, so that default
# refuses the connection every time regardless of whether the sibling started
# fine. Confirmed by direct reproduction of this exact parent/sibling
# topology (2026-08-24): 127.0.0.1 got connection-refused every time; the
# compose-level `extra_hosts: host.docker.internal:host-gateway` entry on
# design-agent-worker plus reaching the sibling via that hostname resolved
# it. Overridable so a non-Docker-outside-of-Docker deployment (this script
# run directly on a host with a real Docker daemon) can still use loopback.
DESIGN_AGENT_SANDBOX_HOST = os.getenv("DESIGN_AGENT_SANDBOX_HOST", "host.docker.internal")

# host.docker.internal:host-gateway (above) still crosses into the true
# Docker host's own network namespace — a `docker run -p` publish is NAT'd
# on the host itself, and that is exactly the kind of host-facing traffic a
# host firewall (ufw's default INPUT policy is a common, well-documented
# real case) can block even when the sandbox container is completely
# healthy. Confirmed as the live, unresolved blocker on staging as of
# 2026-08-24: the exact fixed image, run locally with the identical
# Docker-outside-of-Docker topology and the identical fix, worked
# perfectly — proving the code path itself is correct — yet a real staging
# job still failed the same way, meaning something specific to that one
# VPS's network path is still blocking it, most likely its firewall.
#
# When set, this is a second Docker network (in addition to whatever
# network=None/default the sibling would otherwise get) both this process's
# own container AND the sibling join, so a fallback path exists that never
# needs the host-published port at all: container-to-container traffic over
# a shared user-defined bridge stays inside Docker's own bridge/FORWARD-chain
# handling, which a host firewall's INPUT rules typically do not govern —
# unlike the host.docker.internal path above. Left unset by default so a
# deployment that hasn't defined this network (e.g. plain local dev) is
# completely unaffected; docker-compose.yml sets it to "hosting", the same
# network design-agent-worker already joins.
DESIGN_AGENT_SANDBOX_NETWORK = os.getenv("DESIGN_AGENT_SANDBOX_NETWORK") or None


def sandbox_workspace_kwargs(port_finder):
    """The host_port/host DockerWorkspace kwargs that route its health check
    and API calls through DESIGN_AGENT_SANDBOX_HOST instead of its own
    127.0.0.1 default. Pulled out as its own function (rather than inlined at
    the call site) purely so it's unit-testable without a Docker daemon or
    the OpenHands SDK — `port_finder` is the SDK's own
    find_available_tcp_port, passed in rather than imported here so tests can
    substitute a deterministic one.
    """
    port = port_finder()
    if port == -1:
        raise RuntimeError("No available TCP port found for the Design Agent sandbox container")
    kwargs = {
        "host_port": port,
        "host": f"http://{DESIGN_AGENT_SANDBOX_HOST}:{port}",
    }
    if DESIGN_AGENT_SANDBOX_NETWORK:
        kwargs["network"] = DESIGN_AGENT_SANDBOX_NETWORK
    return kwargs


def _container_ip_on_network(container_id, network, docker_bin=None):
    """The sibling container's own IP address on `network` — used only by
    the same-network fallback below, to reach it directly rather than via a
    host-published port. Never raises; returns None on any failure (missing
    container, network not joined, docker not reachable) so the caller can
    cleanly fall through to re-raising the original error instead."""
    docker_bin = docker_bin or os.getenv("DESIGN_AGENT_DOCKER_BIN", "docker")
    try:
        inspect = subprocess.run(
            [docker_bin, "inspect", "-f",
             "{{(index .NetworkSettings.Networks \"" + network + "\").IPAddress}}", container_id],
            capture_output=True, text=True, timeout=10,
        )
        ip = inspect.stdout.strip()
        return ip or None
    except Exception:
        return None


def open_sandbox_workspace(*, docker_workspace_cls, remote_workspace_cls, server_image, volumes, working_dir, port_finder, network, alive_timeout=60):
    """Start (or reconnect to) this job's sandbox container, preferring
    DockerWorkspace's own host-published-port health check and falling back
    to a direct same-network connection only when that specific path is what
    failed — see DESIGN_AGENT_SANDBOX_NETWORK's docstring for why the two
    differ (crossing into the host's network namespace vs. staying on a
    shared Docker bridge) and why only ENVIRONMENT_CONTAINER_UNHEALTHY
    (container started, health check on the host-published path couldn't
    reach it) is eligible — every other failure (Docker itself unreachable,
    `docker run` rejected) means there is no running sibling to fall back to
    in the first place, so re-raising immediately is correct there.

    Returns (workspace, cleanup, container_id, used_fallback) — cleanup must
    always be called by the caller instead of relying on `with`, since the
    fallback path returns a bare RemoteWorkspace that has no Docker-container
    lifecycle of its own (see RemoteWorkspace's own docstring: it connects to
    an already-running agent-server, it does not manage one) and cleanup
    here must stop the container ourselves. `used_fallback` lets the caller
    log which path actually served the job, for the same reason every other
    branch in this file distinguishes its failure paths — silently
    succeeding via a fallback with no record of it having been needed would
    hide that the primary path is still broken.

    dependency-injected classes/callables (docker_workspace_cls,
    remote_workspace_cls, port_finder) purely so this is unit-testable
    without a Docker daemon or the OpenHands SDK.
    """
    # Reserved once, up front, so it's available to every except branch below
    # even though DockerWorkspace() itself never hands it back on failure —
    # this is what lets orphan discovery below be scoped to a container this
    # attempt could actually have started, instead of "whatever agent-server-*
    # container is newest" (see _find_orphaned_sandbox_container's docstring
    # for why that used to be unsafe).
    kwargs = sandbox_workspace_kwargs(port_finder)
    host_port = kwargs["host_port"]
    try:
        workspace = docker_workspace_cls(
            server_image=server_image, volumes=volumes, working_dir=working_dir, **kwargs,
        )
        return workspace, workspace.cleanup, getattr(workspace, "_container_id", None), False
    except Exception as err:
        err.host_port = host_port
        if not network or classify_sandbox_construction_error(str(err)) != "ENVIRONMENT_CONTAINER_UNHEALTHY":
            raise
        orphan_id = _find_orphaned_sandbox_container(host_port=host_port)
        if not orphan_id:
            raise
        ip = _container_ip_on_network(orphan_id, network)
        if not ip:
            # Found the orphan but can't reach it even on the shared
            # network (e.g. it wasn't actually joined to it) — a container
            # we're never going to use from here on, so it must be stopped
            # now rather than left running: nothing else in this process
            # still holds its id once this exception propagates.
            _try_stop_container(orphan_id)
            raise
        fallback = remote_workspace_cls(host=f"http://{ip}:8000", working_dir=working_dir)
        deadline = time.time() + alive_timeout
        while time.time() < deadline:
            if fallback.alive:
                break
            time.sleep(1.0)
        else:
            # Reachable on the network but never became healthy within the
            # timeout — genuinely broken, not just unreachable via the
            # primary path. Same reasoning as above: stop it before giving
            # up, or it leaks for good.
            _try_stop_container(orphan_id)
            raise

        def cleanup():
            _try_stop_container(orphan_id)

        return fallback, cleanup, orphan_id, True

# Mirrors server/implementers/lib/design-drift.js's REQUIRED_PLACEHOLDERS —
# kept in sync by hand (small, stable, cross-language) rather than shared,
# same as any other JS<->Python contract in this repo. The Node-side
# validatePlaceholders (design-drift.js) is the real enforcement point; this
# is only used to make the prompt precise about exact tokens.
REQUIRED_PLACEHOLDERS = {
    "faq": {"wrapper": ["{{ROWS}}"], "row": ["{{QUESTION}}", "{{ANSWER}}"]},
    "expand-content": {"wrapper": ["{{ROWS}}"], "row": ["{{HEADING}}", "{{BODY}}"]},
    "internal-links": {"wrapper": ["{{ROWS}}"], "row": ["{{URL}}", "{{ANCHOR_TEXT}}"]},
    "qa-content": {"wrapper": ["{{ROWS}}"], "row": ["{{QUESTION}}", "{{ANSWER}}"]},
    # Whole-page markdown content (compliance pages) — one {{BODY}} slot,
    # no repeating "row" the way the others above have.
    "content-wrapper": {"wrapper": ["{{BODY}}"]},
}


class _Terminated(SystemExit):
    """Raised from the SIGTERM handler so any active `with` block's __exit__
    (in particular DockerWorkspace.cleanup()) still runs on the way out."""


def _install_sigterm_handler():
    def _handler(signum, frame):  # noqa: ARG001 — signal handler signature
        raise _Terminated(f"terminated by signal {signum}")

    signal.signal(signal.SIGTERM, _handler)


def _capture_container_diagnostics(container_id, docker_bin=None):
    """Best-effort snapshot of why the sandbox container died — `docker
    inspect` (exit code, OOM flag, state error) plus a tail of `docker logs`
    — captured the moment conversation.run() raises, BEFORE the `with
    DockerWorkspace(...)` block's own __exit__ (-> cleanup() -> `docker
    stop`, which also removes it since `--rm` was used) can make the
    container permanently unreachable. Without this, a mid-run container
    death reached the job row as nothing more than the SDK's own generic
    sentence ("Container stopped unexpectedly" / "No such container") with
    no way to tell OOM, image crash, or a killed daemon apart after the
    fact. Never allowed to raise itself — a diagnostics failure must not
    mask the real one, so every step here is independently try/excepted."""
    if not container_id:
        return {}
    docker_bin = docker_bin or os.getenv("DESIGN_AGENT_DOCKER_BIN", "docker")
    diagnostics = {}
    # `docker logs` first, `docker inspect` second — a container that has
    # already stopped keeps serving its last recorded State to `inspect` for
    # a bit after `--rm` starts removing it, but stops serving `logs` sooner
    # ("can not get logs from container which is dead or marked for
    # removal"). Confirmed live on job 1742: inspect still returned a real
    # exitCode/oomKilled/status, but the logs call one step later hit that
    # exact error — losing the one piece of evidence (the container's own
    # stdout/stderr right before it died) that would have said WHY it
    # stopped, leaving every future occurrence just as unexplained as this
    # one. Capturing logs first does not fix the underlying race, only
    # narrows the window enough for `logs` to also have a shot at it.
    try:
        logs = subprocess.run(
            [docker_bin, "logs", "--tail", "200", container_id],
            capture_output=True, text=True, timeout=10,
        )
        combined = (logs.stdout or "") + (logs.stderr or "")
        if combined:
            diagnostics["logsTail"] = combined[-4000:]
    except Exception as diag_err:  # noqa: BLE001 — diagnostics must never mask the real failure
        diagnostics["logsError"] = str(diag_err)[:500]
    try:
        inspect = subprocess.run(
            [docker_bin, "inspect", container_id],
            capture_output=True, text=True, timeout=10,
        )
        if inspect.returncode == 0:
            data = json.loads(inspect.stdout)
            state = (data[0].get("State") or {}) if data else {}
            diagnostics["exitCode"] = state.get("ExitCode")
            diagnostics["oomKilled"] = state.get("OOMKilled")
            diagnostics["status"] = state.get("Status")
            if state.get("Error"):
                diagnostics["stateError"] = state.get("Error")
        else:
            diagnostics["inspectError"] = (inspect.stderr or "").strip()[:500]
    except Exception as diag_err:  # noqa: BLE001 — same as above
        diagnostics["inspectError"] = str(diag_err)[:500]
    return diagnostics


def classify_sandbox_construction_error(err_text):
    """`errorClass` for a failure raised from inside DockerWorkspace()'s own
    constructor (docker unreachable, `docker run` rejected, or
    _wait_for_health() timing out/finding the container already exited) —
    a structured, closed-vocabulary hint for lib/failure-classification.js,
    not free text. Pulled out as its own function purely for unit-testing
    without needing to actually trigger any of these failures.

    `container`/`healthy` matches DockerWorkspace's own RuntimeError wording
    ("Container failed to become healthy in time" / "Container stopped
    unexpectedly...") for a container that started but never became usable —
    distinct from ENVIRONMENT_CONTAINER_CRASHED, which is conversation.run()
    failing on a container that WAS healthy (see _ContainerRunError's own
    handler above). Checked after docker/daemon/api-key on purpose: a
    docker-daemon-unreachable message could in principle also mention
    "container" incidentally, and that more specific, more actionable class
    should win."""
    text = err_text.lower()
    if "docker" in text or "daemon" in text:
        return "ENVIRONMENT_DOCKER_UNAVAILABLE"
    if "api key" in text or "unauthorized" in text or "authentication" in text:
        return "ENVIRONMENT_MODEL_AUTH"
    if "container" in text or "healthy" in text:
        return "ENVIRONMENT_CONTAINER_UNHEALTHY"
    return None


def classify_container_run_error(err_text):
    """`errorClass` for a failure raised from _ContainerRunError — the
    container passed its own health check and conversation.run() failed on
    it afterward. Pulled out as its own function for the same testability
    reason as classify_sandbox_construction_error above.

    Checked BEFORE the generic docker/daemon match, unlike the sibling
    function: Docker's own CLI/API wraps almost any daemon-returned error as
    "Error response from daemon: ...", including the completely routine
    "can not get logs from container which is dead or marked for removal"
    that fires whenever this code asks for logs from a sandbox that already
    exited and was auto-removed (--rm) — so a message reporting a crashed
    container will very often incidentally contain "daemon" too, and here
    (unlike the construction-error case) that mention is not evidence the
    daemon itself was unreachable. Confirmed live: job 1742 exited cleanly
    (exitCode 0, not OOM-killed — see containerDiagnostics) and was reported
    as ENVIRONMENT_DOCKER_UNAVAILABLE purely because its "Container stopped
    unexpectedly...Error response from daemon" message matched the old
    docker/daemon check first, sending five straight investigations at a
    Docker daemon that was never actually broken."""
    text = err_text.lower()
    if "container stopped unexpectedly" in text or "no such container" in text:
        return "ENVIRONMENT_CONTAINER_CRASHED"
    if "docker" in text or "daemon" in text:
        return "ENVIRONMENT_DOCKER_UNAVAILABLE"
    if "api key" in text or "unauthorized" in text or "authentication" in text:
        return "ENVIRONMENT_MODEL_AUTH"
    if "container" in text:
        return "ENVIRONMENT_CONTAINER_CRASHED"
    return None


def _try_stop_container(container_id, docker_bin=None):
    """Best-effort `docker stop` — every container this process ever starts
    is run with --rm, so stopping it is enough to also remove it. Used by
    open_sandbox_workspace's own cleanup and by its failure branches that
    found a real orphaned container but ultimately couldn't use it: those
    must not leave it running just because they're giving up on it. Never
    raises, so a cleanup failure never masks the real error being reported."""
    docker_bin = docker_bin or os.getenv("DESIGN_AGENT_DOCKER_BIN", "docker")
    try:
        subprocess.run([docker_bin, "stop", container_id], capture_output=True, timeout=30)
    except Exception:
        pass


def _find_orphaned_sandbox_container(docker_bin=None, host_port=None):
    """Best-effort: find the sibling container DockerWorkspace's own
    constructor started, for a failure raised from inside that constructor
    itself (most commonly _wait_for_health() timing out) — we never get a
    workspace instance back in that case (the `with` statement's __enter__
    is never reached, since the exception comes from __init__), so there is
    no container_id available the normal way. DockerWorkspace.cleanup() also
    never runs for the same reason, so if `docker run` did succeed before
    the failure, the container is both still on the host AND about to be
    silently orphaned (leaking indefinitely) unless something finds and
    removes it.

    Scoped by `host_port` — the exact `-p {host_port}:8000` this attempt
    reserved via port_finder() before calling DockerWorkspace() (see
    open_sandbox_workspace) — NOT by "docker ps's newest agent-server-*
    match", which this used to rely on. That assumed one job runs one
    sandbox container at a time on the whole host, so the most recent match
    was always this attempt's own container. That assumption breaks the
    moment any two agent-server-* containers exist on the host at once — a
    second worker, a manual run, or (per this platform's own stated
    direction) a self-healing escalation path invoked outside the normal
    queue — and there is nothing distinguishing "my own just-failed
    container" from "someone else's perfectly healthy one" in the name
    alone; grabbing the newest match unconditionally risked `docker rm -f`
    force-killing a live sibling job's container (this branch) or, in
    open_sandbox_workspace's fallback branch, hijacking it as this job's own
    workspace. `host_port` is unique per attempt (port_finder() only ever
    hands out an unused port), so matching on it can only ever identify a
    container this exact attempt could have started.

    When host_port is None (a caller that predates this scoping, or one that
    genuinely has no port to give), this returns None rather than falling
    back to the old unscoped newest-match behavior — a real orphan going
    briefly unswept is a much smaller cost than force-killing someone else's
    running job. Never raises — same discipline as
    _capture_container_diagnostics; a diagnostics failure must not mask the
    real one."""
    if host_port is None:
        return None
    docker_bin = docker_bin or os.getenv("DESIGN_AGENT_DOCKER_BIN", "docker")
    port_marker = f":{host_port}->"
    try:
        listing = subprocess.run(
            [docker_bin, "ps", "-a", "--filter", "name=^agent-server-", "--format", "{{.ID}}\t{{.Ports}}"],
            capture_output=True, text=True, timeout=10,
        )
        if listing.returncode != 0:
            return None
        for line in listing.stdout.splitlines():
            container_id, _, ports = line.partition("\t")
            if container_id and port_marker in ports:
                return container_id
        return None
    except Exception:
        return None


class _ContainerRunError(Exception):
    """Raised when conversation.run()/send_message() fails while the sandbox
    container is still known to exist (as opposed to DockerWorkspace()
    itself failing to start one at all, which the outer except still
    handles). Carries a best-effort diagnostic snapshot captured before
    cleanup makes the container unreachable — see
    _capture_container_diagnostics above for why that timing matters."""

    def __init__(self, message, diagnostics=None):
        super().__init__(message)
        self.diagnostics = diagnostics or {}


FIXTURE_DEMO_TASK = (
    "This directory is a small static HTML/CSS website fixture. It is NOT a "
    "git repository — do not run any git commands, do not attempt to commit "
    "or push, there is nothing to push to.\n\n"
    "Inspect the existing pages and css/styles.css before making changes.\n\n"
    "Add a small 'Contact' section to about.html only:\n"
    "- Give it its own <section class=\"section\"> with an <h2>Contact</h2> heading.\n"
    "- Include one .card with a short paragraph and a support email address.\n"
    "- Reuse the existing .section/.card styles already defined in "
    "css/styles.css — do not add new CSS classes or a <style> block if the "
    "existing ones already cover this.\n"
    "- Do not modify index.html or faq.html.\n"
    "- Do not introduce a new visual design; match the existing look exactly.\n\n"
    "When you are done, briefly confirm what you changed."
)


def _lessons_block(lessons):
    """Formats agent_fix_memory rows the same way server/agent-memory.js's
    withAgentMemory does for every other generator's system prompt: an
    'auto' row with a fixPattern is stated as reusable guidance, anything
    else surfaces as advisory-only ("do not repeat this")."""
    if not lessons:
        return ""
    bullets = []
    for l in lessons:
        symptoms = l.get("symptoms") or ""
        if not symptoms:
            continue
        fix_pattern = l.get("fixPattern")
        if fix_pattern:
            bullets.append(f"- {symptoms} Fix: {fix_pattern}")
        else:
            root_cause = l.get("rootCause")
            suffix = f" ({root_cause})" if root_cause else ""
            bullets.append(f"- {symptoms}{suffix} [advisory — do not repeat this]")
    if not bullets:
        return ""
    return "\nKnown issues from past design-agent runs — do not repeat these:\n" + "\n".join(bullets) + "\n"


def build_component_templates_task(action_types, lessons=None):
    lines = [
        "This directory is a real, complete checkout of a website's actual source "
        "repository. This is a READ-ONLY analysis task — do not create, edit, or "
        "delete any file, do not run any git commands, do not commit or push.\n",
        "Inspect the repository (framework/build tool, where reusable components "
        "live, how styling is organized — Tailwind/CSS modules/plain CSS/etc.) "
        "before concluding anything.\n",
        "For each of the following content types, find how this site already "
        "renders that kind of content (an existing FAQ section, a related-content/"
        "internal-links block, an expandable content section, the typography "
        "wrapper around long-form Markdown-sourced body content such as a blog "
        "post — whichever of these already exist somewhere in the real site) and "
        "derive an HTML template with EXACTLY the required placeholder tokens, "
        "using ONLY real CSS classes/markup patterns you can actually see used in "
        "the real repository — never invent a class name that doesn't appear "
        "anywhere in the real source. If this site has no existing real example of "
        "a given type, derive a template that matches the site's other real "
        "components' typography/spacing/card style as closely as possible, still "
        "using only real classes seen elsewhere in the repo.\n",
    ]
    for action_type in action_types:
        required = REQUIRED_PLACEHOLDERS.get(action_type)
        if not required:
            continue
        row = required.get("row")
        row_clause = f"; row must contain {', '.join(row)}" if row else ""
        lines.append(
            f"- \"{action_type}\": wrapper must contain {', '.join(required['wrapper'])}{row_clause}."
        )
    lines.append(
        "\nWhen you are done, respond with ONLY a JSON object (no prose, no code "
        "fence) shaped exactly like:\n"
        '{"componentTemplates": {"<action-type>": {"wrapper": "...", "row": "..."}, ...}}\n'
        "One entry per action type listed above that you were able to derive. "
        "Placeholder tokens must appear verbatim in your output."
    )
    task = "\n".join(lines)
    block = _lessons_block(lessons)
    return task + "\n" + block if block else task


DESIGN_PROFILE_SCHEMA = (
    '{\n'
    '  "styling": "tailwind" | "css-modules" | "plain-css" | "unknown",\n'
    '  "framework": "<the site\'s framework/SSG, or null>",\n'
    '  "typography": {\n'
    '    "heading": {"section": "<classes for a major section heading>", "item": "<classes for a repeating item heading, e.g. an FAQ question>"},\n'
    '    "body": "<classes for normal body copy>",\n'
    '    "link": "<classes for an inline text link>"\n'
    '  },\n'
    '  "color": {"text": "...", "muted": "...", "accent": "...", "surface": "...", "border": "..."},\n'
    '  "spacing": {"section": "<vertical spacing for a page section>", "itemGap": "<spacing between repeated items>"},\n'
    '  "layout": {"container": "<the site\'s content container/width constraint>", "prose": "<long-form article wrapper, if any>"},\n'
    '  "components": {\n'
    '    "accordion": {"wrapper": "...", "item": "...", "trigger": "...", "panel": "..."} | null,\n'
    '    "card": {"wrapper": "...", "body": "..."} | null,\n'
    '    "list": {"wrapper": "...", "item": "...", "divider": "..."} | null,\n'
    '    "button": {"primary": "...", "secondary": "..."} | null,\n'
    '    "articleBody": {"wrapper": "<what wraps a blog post / article body>"} | null\n'
    '  },\n'
    '  "responsive": {"breakpoints": ["sm", "md", "lg"]},\n'
    '  "evidence": {"files": ["<real paths you derived this from>"], "notes": "<one short sentence>"}\n'
    '}'
)


def build_design_profile_task(lessons=None):
    """Derive the site's WHOLE design language, once, rather than one
    component's markup.

    This is the source the Node side (design-agent/lib/design-profile.js)
    projects every design-sensitive component template from, so it has to
    describe the site's reusable vocabulary — typography, colour, spacing,
    layout, and the component conventions (cards, buttons, accordions, lists,
    article body) — not any single block's markup. Getting this right once
    means a new content type needs no new repo analysis at all.
    """
    lines = [
        "This directory is a real, complete checkout of a website's actual source "
        "repository. This is a READ-ONLY analysis task — do not create, edit, or "
        "delete any file, do not run any git commands, do not commit or push.\n",
        "Your job is to describe this website's DESIGN LANGUAGE as a whole: the "
        "reusable presentation vocabulary its pages are built from. You are not "
        "describing any one block or page.\n",
        "Work it out from the real source: identify the framework and build tool, "
        "how styling is organised (Tailwind / CSS modules / plain CSS / something "
        "else), where reusable components and layouts live, and which classes and "
        "markup patterns recur across MANY pages rather than appearing once.\n",
        "Cover: typography (headings at each level, body copy, links), colour "
        "(text, muted text, accent, surfaces, borders), spacing (section rhythm, "
        "gaps between repeated items), layout (content container/width, long-form "
        "article wrapper), the component conventions this site actually uses "
        "(cards, buttons, accordions/disclosures, lists, how a blog post or "
        "article body is presented), and which responsive breakpoints appear.\n",
        "ABSOLUTE RULE: every class name and markup pattern you report must "
        "actually appear in this repository's real source. Never invent a class "
        "name, and never copy one from a framework's documentation. If this site "
        "genuinely has no example of something (no accordion, say), report null "
        "for it rather than inventing one — a missing pattern is a real, useful "
        "answer and downstream code handles it correctly.\n",
        "Report only presentation vocabulary. Do not include page content, copy, "
        "product names, or anything specific to this business.\n",
        "When you are done, respond with ONLY a JSON object (no prose, no code "
        "fence) shaped exactly like:\n" + DESIGN_PROFILE_SCHEMA,
    ]
    task = "\n".join(lines)
    block = _lessons_block(lessons)
    return task + "\n" + block if block else task


# Bounds the before/after snapshot (and therefore what the agent is even
# told it may touch) to real application code — never migrations (a code fix
# should not also silently alter the database schema), never
# package.json/package-lock.json (a dependency change is a decision for a
# human, not an autonomous repair), never node_modules or .git.
CODE_SELF_REPAIR_ROOT = "server"
CODE_SELF_REPAIR_EXCLUDED_DIRS = {"node_modules", ".git", "migrations"}


def build_code_self_repair_task(payload):
    """The investigate-and-fix task for a repeated generator/implementer
    failure — server/agents/lib/code-self-repair.js only calls this mode
    once auto-remediation.js's sweep has already confirmed the SAME
    (generatorId, reason) pair failed on 2+ distinct calendar days, so the
    prompt states that evidence as a given, not something to re-derive."""
    generator_id = payload.get("generatorId") or "(unknown generator)"
    reason = payload.get("reason") or "(unknown reason)"
    error_message = payload.get("errorMessage") or "(no error message captured)"
    occurrence_days = payload.get("occurrenceDays")
    test_file_hint = payload.get("testFileHint")

    lines = [
        "This directory is a real, complete checkout of this platform's own "
        f"application repository, on its integration branch ({CODE_SELF_REPAIR_ROOT}/ "
        "is where all server-side code lives). This is a real code-editing task: "
        "you may read and edit files, and run commands with the terminal tool.\n",
        f"A generator/implementer with id \"{generator_id}\" has been failing or "
        f"refusing with the same reason (\"{reason}\") on at least "
        f"{occurrence_days or 2} separate calendar days, across real client sites. "
        "This is not a one-off — it is evidence of a real bug in the shared "
        "platform code itself, not in any one site's content.\n",
        f"The error/detail captured from a real failed attempt: {error_message}\n",
        "Do NOT simply retry the original recommendation or generate new "
        "content — that is not your job here. Investigate the ACTUAL PLATFORM "
        "IMPLEMENTATION: find the generator in server/generators/, the "
        "implementer/adapter in server/implementers/ (and any shared helper it "
        "calls, e.g. server/implementers/adapters/lib/, server/implementers/lib/) "
        "that this generator id and failure reason point to. Read the relevant "
        "code and its existing test file before changing anything.\n",
        "Identify the real root cause. Implement the SMALLEST safe fix — do not "
        "refactor, rename, or restructure anything beyond what the bug requires. "
        "Do not add speculative error handling, comments, or abstractions.\n",
    ]
    if test_file_hint:
        lines.append(
            f"Run the existing test file at {test_file_hint} with the terminal "
            f"tool (`node --test {test_file_hint}`) and confirm it passes after "
            "your fix. If you can write a small additional test case that "
            "reproduces the original bug, add it to that same file.\n"
        )
    else:
        lines.append(
            "Find and run this code's existing test file(s) with the terminal "
            "tool (`node --test <path>`) and confirm they pass after your fix. "
            "If no test file exists yet for the exact function you changed, add "
            "a small one next to the code, matching this repo's existing test "
            "style (node:test + node:assert/strict).\n"
        )
    lines.append(
        f"Only touch files under {CODE_SELF_REPAIR_ROOT}/. Never touch "
        f"{CODE_SELF_REPAIR_ROOT}/migrations/, package.json, or "
        "package-lock.json. Do not run any git commands — do not commit, do "
        "not push; another process handles that after you finish.\n"
    )
    lines.append(
        "When you are done, respond with ONLY a JSON object (no prose, no code "
        "fence) shaped exactly like:\n"
        '{"summary": "<one sentence, what was wrong>", '
        '"rootCause": "<one or two sentences, the real cause>", '
        '"testCommand": "<the exact command you ran to validate>", '
        '"testsPassed": true or false}\n'
        "Report testsPassed truthfully — it will be checked independently "
        "either way, but a false claim here is worse than an honest failure."
    )
    return "\n".join(lines)


# Generic multi-tenant task for the ONE case
# server/agents/lib/template-capability-repair.js's classifyCapabilityGap
# calls 'architectural-gap': a recommendation type has no rendering slot on
# its own template, AND no sibling route in this same site (one sharing the
# same data file) already solved it either — so there is no existing
# pattern in THIS site's own url_file_map config to safely clone. Runs
# against a real client repo checkout (same workspaceSource as
# component-templates/design-profile mode), but — like code-self-repair
# mode — is an EDITING task: it adds the smallest new data field + template
# rendering slot, never invented from nothing but derived from real evidence
# the Node side supplies (this exact template's/data file's real current
# content, plus any real example of this site's own AI-managed-slot
# convention found ELSEWHERE in the repo, if one exists at all). Nothing
# here is generator-, tenant-, or field-name-specific — every identifier in
# the constructed prompt comes from `payload`.
def build_capability_repair_task(payload):
    generator_id = payload.get("generatorId") or "(unknown generator)"
    value_key = payload.get("valueKey") or "(unknown value key)"
    template_path = payload.get("templatePath") or "(unknown template path)"
    template_source = payload.get("templateSource") or ""
    data_file_path = payload.get("dataFilePath") or "(unknown data file path)"
    data_file_source = payload.get("dataFileSource") or ""
    examples = payload.get("conventionExamples") or []

    lines = [
        "This directory is a real, complete checkout of a client website's "
        "actual source repository. This is a real code-editing task: you "
        "may read and edit files, and run commands with the terminal "
        "tool.\n",
        f"A recommendation of type \"{generator_id}\" is blocked for every "
        f"page rendered from {data_file_path} via the template "
        f"{template_path}: there is no existing place on that page for "
        "AI-generated content of this kind to render, and no sibling route "
        "in this site's own configuration already solved it. Your job is "
        "to add the SMALLEST new capability that lets it render — a new "
        "field on the relevant data entries, and a rendering slot in "
        f"{template_path} that displays it.\n",
        f"The real current content of {template_path}:\n---\n{template_source}\n---\n",
        f"The real current content of {data_file_path}:\n---\n{data_file_source}\n---\n",
    ]
    if examples:
        lines.append(
            "This site already expresses AI-managed content elsewhere "
            "using this exact convention — match it precisely, do not "
            "invent a different shape:\n"
        )
        for ex in examples:
            lines.append(f"From {ex.get('path')}:\n---\n{ex.get('snippet')}\n---\n")
    else:
        lines.append(
            "This site has no existing example of this convention "
            "anywhere in the repository. Use this exact, minimal shape (a "
            "Nunjucks comment naming this generator, then an if-guard, "
            "then the output) so it stays machine-readable by this "
            "platform later:\n"
            "{# AI-managed: server/generators/" + generator_id + ".js #}\n"
            "{% if <base>." + value_key + " %}\n"
            "{{ <base>." + value_key + " | safe }}\n"
            "{% endif %}\n"
            "— replace <base> with whatever variable this template "
            "already uses to reference the current data entry (read the "
            "template to find it; never guess a name that doesn't appear "
            "in it).\n"
        )
    lines.append(
        f"Add the field as \"{value_key}\" (this exact name — it is what "
        "the platform's own generator writes into later) to the data "
        "file, matching its existing structure and quoting style exactly. "
        "Do NOT populate it with placeholder content on every entry — the "
        "field is meant to start absent/empty and be filled in later; the "
        "template's own if-guard already handles that safely. Only add it "
        "to the ONE entry you use to prove the change works end-to-end, "
        "if you need a concrete example to validate against.\n"
    )
    lines.append(
        f"Only touch {template_path} and {data_file_path}. Do not touch "
        "any other file. Do not add speculative error handling, "
        "comments, or abstractions beyond what this requires. Do not run "
        "any git commands — do not commit, do not push; another process "
        "handles that after you finish.\n"
    )
    lines.append(
        "When you are done, respond with ONLY a JSON object (no prose, no "
        "code fence) shaped exactly like:\n"
        '{"summary": "<one sentence, what you added>", '
        '"fieldName": "<the exact field name you added>", '
        '"baseVar": "<the exact template variable you guarded on>"}'
    )
    return "\n".join(lines)


# Reads the CLIENT repo's own package.json for a declared "build" script —
# never assumes npm/yarn/pnpm, or any specific command, since that varies
# per tenant and this must stay generic across all of them. Returns None
# (never a guessed fallback) when no build script is declared at all, so
# the caller fails honestly rather than running a command that might not
# mean anything for this repo.
def _detect_build_command(workspace_dir):
    pkg_path = os.path.join(workspace_dir, "package.json")
    if not os.path.isfile(pkg_path):
        return None
    try:
        with open(pkg_path, "r", encoding="utf-8") as f:
            pkg = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(pkg.get("scripts"), dict) or not pkg["scripts"].get("build"):
        return None
    if os.path.isfile(os.path.join(workspace_dir, "pnpm-lock.yaml")):
        return ["pnpm", "run", "build"]
    if os.path.isfile(os.path.join(workspace_dir, "yarn.lock")):
        return ["yarn", "build"]
    return ["npm", "run", "build"]


# Companion to _detect_build_command: the matching dependency-install
# command for whichever package manager that function picked, keyed off
# the exact same lockfile evidence so the two can never disagree. Unlike
# server/scripts/repair-template-capability.js's own safe-capability-gap
# path (which validates via the client's own GitHub Actions CI instead of
# installing the client's dependency tree locally — see that script's own
# header comment for why an EARLIER attempt at a local `npm ci && npm run
# build` was abandoned there), this one runs inside the ephemeral OpenHands
# sandbox container, not the long-lived design-agent-worker orchestrator —
# a real, general-purpose dev environment with outbound network access and
# nothing of any tenant's ever installed in it permanently, so installing
# fresh here each run is the intended use of that sandbox rather than the
# resource/isolation problem it would be inside the orchestrator.
def _detect_install_command(workspace_dir):
    if os.path.isfile(os.path.join(workspace_dir, "pnpm-lock.yaml")):
        return ["pnpm", "install", "--frozen-lockfile"]
    if os.path.isfile(os.path.join(workspace_dir, "yarn.lock")):
        return ["yarn", "install", "--frozen-lockfile"]
    return ["npm", "ci"]


def _snapshot_specific_files(workspace_dir, relpaths):
    """Narrower counterpart to _snapshot_code_files, for capability-repair
    mode: only the exact files the agent was told it may touch, rather than
    every .js/.mjs file in the repo. Bounding the snapshot to this known set
    is itself the "only affects the intended page family" guarantee — any
    file outside it is invisible to _diff_snapshots and so can never appear
    in changed_files, regardless of what the agent's own final message
    claims to have done."""
    snapshot = {}
    for relpath in relpaths:
        if not relpath:
            continue
        try:
            with open(os.path.join(workspace_dir, relpath), "r", encoding="utf-8") as f:
                snapshot[relpath] = f.read()
        except (OSError, UnicodeDecodeError):
            snapshot[relpath] = None  # genuinely absent/unreadable before the agent's turn
    return snapshot


def _validate_capability_repair(workspace_dir, template_path, data_file_path, changed_files):
    """Independent validation for a capability-repair task — never trusts
    the agent's own self-report. In order: (1) only the two files it was
    told about actually changed (enforced structurally by
    _snapshot_specific_files above, checked again here as a second,
    explicit gate); (2) the data file, if JS/JSON, is still syntactically
    valid; (3) the client repo's OWN build command still succeeds — the
    strongest real evidence the change is safe, since it exercises the
    exact toolchain (Eleventy or otherwise) the client's real site is built
    with. Never runs a guessed build command."""
    if not changed_files:
        return {"ok": False, "output": "Agent made no file changes."}

    allowed = {p for p in (template_path, data_file_path) if p}
    unexpected = [c["path"] for c in changed_files if c["path"] not in allowed]
    if unexpected:
        return {"ok": False, "output": f"Agent touched file(s) outside the intended scope: {unexpected}"}

    for entry in changed_files:
        if entry["path"] != data_file_path:
            continue
        if data_file_path.endswith((".js", ".mjs")):
            check = _run_subprocess(["node", "--check", entry["path"]], cwd=workspace_dir, timeout=30)
            if not check["ok"]:
                return {"ok": False, "output": f"node --check failed for {entry['path']}:\n{check['output']}"}
        elif data_file_path.endswith(".json"):
            try:
                json.loads(entry["newContent"])
            except json.JSONDecodeError as err:
                return {"ok": False, "output": f"{entry['path']} is not valid JSON after the change: {err}"}

    build_cmd = _detect_build_command(workspace_dir)
    if not build_cmd:
        return {"ok": False, "output": "Could not find a \"build\" script in this repo's package.json — refusing to guess a build command."}

    install_cmd = _detect_install_command(workspace_dir)
    install_result = _run_subprocess(install_cmd, cwd=workspace_dir, timeout=600)
    if not install_result["ok"]:
        return {"ok": False, "output": f"$ {' '.join(install_cmd)}\n{install_result['output']}"}

    result = _run_subprocess(build_cmd, cwd=workspace_dir, timeout=300)
    output = f"$ {' '.join(install_cmd)}\n(installed OK)\n\n$ {' '.join(build_cmd)}\n{result['output']}"
    return {"ok": result["ok"], "output": output}


def _iter_code_files(root_dir):
    """Every real .js/.mjs source or test file under CODE_SELF_REPAIR_ROOT,
    skipping the excluded dirs — the bounded set this snapshots before/after
    the agent's turn to discover exactly what it touched, independent of
    (and not trusting) its own filesChanged self-report."""
    base = os.path.join(root_dir, CODE_SELF_REPAIR_ROOT)
    if not os.path.isdir(base):
        return
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in CODE_SELF_REPAIR_EXCLUDED_DIRS]
        for name in filenames:
            if name.endswith((".js", ".mjs")):
                yield os.path.relpath(os.path.join(dirpath, name), root_dir)


def _snapshot_code_files(root_dir):
    snapshot = {}
    for relpath in _iter_code_files(root_dir):
        try:
            with open(os.path.join(root_dir, relpath), "r", encoding="utf-8") as f:
                snapshot[relpath] = f.read()
        except (OSError, UnicodeDecodeError):
            continue
    return snapshot


def _diff_snapshots(before, after):
    """Real changed/added files only (never a deleted-file entry — deleting
    platform code is never the smallest safe fix for a splice/escaping bug,
    and a legitimate delete needs a human PR description explaining why, not
    an autonomous one). Returns [{path, newContent, patch}]."""
    changed = []
    for relpath, new_content in after.items():
        old_content = before.get(relpath)
        if old_content == new_content:
            continue
        patch_lines = difflib.unified_diff(
            (old_content or "").splitlines(keepends=True),
            new_content.splitlines(keepends=True),
            fromfile=f"a/{relpath}",
            tofile=f"b/{relpath}",
        )
        changed.append({
            "path": relpath,
            "newContent": new_content,
            "patch": "".join(patch_lines),
        })
    return changed


def _run_subprocess(cmd, cwd, timeout=120):
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        output = proc.stdout.decode("utf-8", errors="replace")[-4000:]
        return {"ok": proc.returncode == 0, "output": output}
    except subprocess.TimeoutExpired:
        return {"ok": False, "output": f"timed out after {timeout}s"}
    except OSError as err:
        return {"ok": False, "output": str(err)}


def _validate_code_self_repair(workspace_dir, changed_files, test_file_hint):
    """The independent validation gate — never trusts the agent's own
    TerminalTool run or its self-reported testsPassed. A syntactically
    invalid file, or a failing/missing test run, means this is NOT a
    successful repair, no matter what the agent's final message claims."""
    if not changed_files:
        return {"ok": False, "output": "Agent made no file changes."}

    for entry in changed_files:
        check = _run_subprocess(["node", "--check", entry["path"]], cwd=workspace_dir, timeout=30)
        if not check["ok"]:
            return {"ok": False, "output": f"node --check failed for {entry['path']}:\n{check['output']}"}

    test_targets = [test_file_hint] if test_file_hint else [
        e["path"] for e in changed_files if e["path"].endswith(".test.js")
    ]
    if not test_targets:
        # A fix with no test file at all to run is not validated, by this
        # module's own contract — see build_code_self_repair_task's
        # instruction to add one when none exists.
        return {"ok": False, "output": "No test file available to validate against (no testFileHint, and the agent added no *.test.js file)."}

    combined_output = []
    for test_path in test_targets:
        full_path = os.path.join(workspace_dir, test_path)
        if not os.path.isfile(full_path):
            return {"ok": False, "output": f"Expected test file not found after the agent's changes: {test_path}"}
        result = _run_subprocess(["node", "--test", test_path], cwd=workspace_dir, timeout=120)
        combined_output.append(f"$ node --test {test_path}\n{result['output']}")
        if not result["ok"]:
            return {"ok": False, "output": "\n\n".join(combined_output)}
    return {"ok": True, "output": "\n\n".join(combined_output)}


def _extract_json_object(text):
    """Lenient JSON extraction from an LLM's final message — same tolerance
    server/llm.js's extractJson gives JS callers (strip a code fence, or pull
    the first balanced {...} block out of surrounding prose), reimplemented
    here since this is the Python side of the same class of problem."""
    if not text:
        return None
    stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    try:
        return json.loads(stripped)
    except (json.JSONDecodeError, TypeError):
        pass
    start = stripped.find("{")
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(stripped)):
        if stripped[i] == "{":
            depth += 1
        elif stripped[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(stripped[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _last_agent_message_text(conversation):
    from openhands.sdk.event import MessageEvent
    from openhands.sdk.llm import content_to_str

    for event in reversed(conversation.state.events):
        if isinstance(event, MessageEvent) and event.source == "agent":
            return "\n".join(content_to_str(event.llm_message.content))
    return None


def main() -> int:
    if len(sys.argv) < 2:
        print(RESULT_PREFIX + json.dumps({"status": "error", "detail": "usage: design_task.py <workspace-dir> [mode] [mode-args-json]"}))
        return 1
    workspace_dir = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "fixture-demo"
    _install_sigterm_handler()

    try:
        from openhands.sdk import LLM, Agent, Conversation, Tool
        from openhands.tools.file_editor import FileEditorTool
        from openhands.tools.task_tracker import TaskTrackerTool
        from openhands.tools.terminal import TerminalTool
        from openhands.workspace.docker import DockerWorkspace
        from openhands.workspace.docker.workspace import find_available_tcp_port
        from openhands.sdk.workspace import RemoteWorkspace

        llm = LLM(
            model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
            api_key=os.getenv("LLM_API_KEY"),
            base_url=os.getenv("LLM_BASE_URL") or None,
        )

        agent = Agent(
            llm=llm,
            tools=[
                Tool(name=TerminalTool.name),
                Tool(name=FileEditorTool.name),
                Tool(name=TaskTrackerTool.name),
            ],
        )

        if mode == "component-templates":
            action_types = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []
            lessons = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else []
            task = build_component_templates_task(action_types, lessons)
        elif mode == "design-profile":
            # argv[3] is unused for this mode (there is nothing to scope it to
            # — the whole site IS the scope); argv[4] stays the lessons array
            # so the argument positions match component-templates mode exactly.
            lessons = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else []
            task = build_design_profile_task(lessons)
        elif mode == "code-self-repair":
            payload = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else {}
            task = build_code_self_repair_task(payload)
            code_repair_before = _snapshot_code_files(workspace_dir)
        elif mode == "capability-repair":
            payload = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else {}
            task = build_capability_repair_task(payload)
            capability_repair_before = _snapshot_specific_files(
                workspace_dir, [payload.get("templatePath"), payload.get("dataFilePath")]
            )
        else:
            task = FIXTURE_DEMO_TASK

        # One throwaway container per job (server_image is the default
        # pre-built OpenHands agent server — not our own image), bind-mounted
        # to this job's own host temp dir so no two jobs ever share a
        # workspace, container, or host directory. open_sandbox_workspace's
        # own cleanup (in `finally` below) replaces `with`'s guarantee,
        # since the fallback path it can take needs different cleanup than
        # DockerWorkspace's own — still runs on the way out, including on
        # the _Terminated exit raised by the SIGTERM handler above.
        workspace, cleanup_workspace, container_id, used_fallback = open_sandbox_workspace(
            docker_workspace_cls=DockerWorkspace,
            remote_workspace_cls=RemoteWorkspace,
            server_image=DOCKER_IMAGE,
            volumes=[f"{workspace_dir}:/workspace"],
            working_dir="/workspace",
            port_finder=find_available_tcp_port,
            network=DESIGN_AGENT_SANDBOX_NETWORK,
        )
        try:
            print(CONTAINER_PREFIX + json.dumps({"container_id": container_id, "usedSameNetworkFallback": used_fallback}))

            conversation = Conversation(agent=agent, workspace=workspace)
            try:
                conversation.send_message(task)
                conversation.run()
            except _Terminated:
                raise
            except Exception as run_err:  # noqa: BLE001 — captured, then re-raised as _ContainerRunError below
                # The container is still known to exist at this point (we
                # have container_id, and __exit__ below hasn't run yet) —
                # this is the only window where `docker inspect`/`docker
                # logs` can still see it once it has already stopped.
                raise _ContainerRunError(str(run_err), _capture_container_diagnostics(container_id)) from run_err

            result = {"status": "ok", "detail": "conversation.run() completed"}
            if mode == "component-templates":
                message_text = _last_agent_message_text(conversation)
                parsed = _extract_json_object(message_text)
                component_templates = parsed.get("componentTemplates") if isinstance(parsed, dict) else None
                if not component_templates:
                    result = {"status": "error", "detail": "Agent did not report a parseable componentTemplates JSON object."}
                else:
                    result["componentTemplates"] = component_templates
            elif mode == "design-profile":
                message_text = _last_agent_message_text(conversation)
                parsed = _extract_json_object(message_text)
                # The agent returns the profile as the bare object. Accept a
                # {"designProfile": {...}} envelope too, since that is the
                # shape it sometimes mirrors back from the schema block.
                profile = None
                if isinstance(parsed, dict):
                    profile = parsed.get("designProfile") if isinstance(parsed.get("designProfile"), dict) else parsed
                if not profile or not profile.get("typography"):
                    result = {"status": "error", "detail": "Agent did not report a parseable design profile with typography."}
                else:
                    result["designProfile"] = profile
            elif mode == "code-self-repair":
                message_text = _last_agent_message_text(conversation)
                parsed = _extract_json_object(message_text) or {}
                code_repair_after = _snapshot_code_files(workspace_dir)
                changed_files = _diff_snapshots(code_repair_before, code_repair_after)
                test_file_hint = None
                try:
                    test_file_hint = json.loads(sys.argv[3]).get("testFileHint") if len(sys.argv) > 3 and sys.argv[3] else None
                except (json.JSONDecodeError, AttributeError):
                    test_file_hint = None
                validation = _validate_code_self_repair(workspace_dir, changed_files, test_file_hint)
                if not validation["ok"]:
                    result = {
                        "status": "error",
                        "detail": f"Repair could not be validated: {validation['output']}",
                        "rootCause": parsed.get("rootCause"),
                        "summary": parsed.get("summary"),
                        "testsPassed": False,
                        "testOutput": validation["output"],
                    }
                else:
                    result.update({
                        "rootCause": parsed.get("rootCause"),
                        "summary": parsed.get("summary"),
                        "testsPassed": True,
                        "testOutput": validation["output"],
                        "patch": "\n".join(f["patch"] for f in changed_files),
                        "filesChanged": [{"path": f["path"], "newContent": f["newContent"]} for f in changed_files],
                    })
            elif mode == "capability-repair":
                message_text = _last_agent_message_text(conversation)
                parsed = _extract_json_object(message_text) or {}
                capability_repair_after = _snapshot_specific_files(
                    workspace_dir, [payload.get("templatePath"), payload.get("dataFilePath")]
                )
                changed_files = _diff_snapshots(capability_repair_before, capability_repair_after)
                validation = _validate_capability_repair(
                    workspace_dir, payload.get("templatePath"), payload.get("dataFilePath"), changed_files
                )
                if not validation["ok"]:
                    result = {
                        "status": "error",
                        "detail": f"Capability repair could not be validated: {validation['output']}",
                        "summary": parsed.get("summary"),
                        "testsPassed": False,
                        "testOutput": validation["output"],
                    }
                else:
                    result.update({
                        "summary": parsed.get("summary"),
                        "fieldName": parsed.get("fieldName"),
                        "baseVar": parsed.get("baseVar"),
                        "testsPassed": True,
                        "testOutput": validation["output"],
                        "patch": "\n".join(f["patch"] for f in changed_files),
                        "filesChanged": [{"path": f["path"], "newContent": f["newContent"]} for f in changed_files],
                    })
        finally:
            cleanup_workspace()

        print(RESULT_PREFIX + json.dumps(result))
        return 0 if result["status"] == "ok" else 1
    except _Terminated as err:
        print(RESULT_PREFIX + json.dumps({"status": "error", "detail": str(err)}))
        return 1
    except _ContainerRunError as err:
        # Same closed-vocabulary contract as the generic except below, plus
        # `containerDiagnostics` — a snapshot captured while the container
        # still existed, since __exit__ (docker stop, which removes it) has
        # already run by the time we get here and nothing more can be
        # learned about it now.
        error_class = classify_container_run_error(str(err))
        payload = {"status": "error", "detail": str(err)}
        if error_class:
            payload["errorClass"] = error_class
        if err.diagnostics:
            payload["containerDiagnostics"] = err.diagnostics
        print(RESULT_PREFIX + json.dumps(payload))
        return 1
    except Exception as err:  # noqa: BLE001 — any SDK/LLM/Docker failure maps to a failed job, not a crash
        # `errorClass` is a structured, closed-vocabulary hint for the Node
        # side (lib/failure-classification.js), NOT free text. Without it an
        # environment fault here — no Docker daemon, an unpullable sandbox
        # image, a missing model key — arrives as an ordinary "error" result
        # and is classified as AGENT_LOGIC, i.e. "our agent reasoned badly",
        # when in fact nothing ever ran and an engineer must fix the host.
        # Confirmed live: a machine with Docker stopped reported exactly
        # "Docker is not available", and was classed as an agent-logic fault.
        # This is a trusted INTERNAL channel (our own script), which is why
        # matching on it is legitimate where matching a third-party provider's
        # message text would not be.
        # Previously this handler only checked docker/daemon/api-key text,
        # so a health-check-timeout failure (which never mentions "docker"
        # or "daemon") fell through to error_class=None — completely
        # unclassified. See classify_sandbox_construction_error's own
        # docstring for the full reasoning.
        error_class = classify_sandbox_construction_error(str(err))

        # The container DockerWorkspace() started (if `docker run` got that
        # far before failing) is orphaned here — cleanup() never ran, since
        # the exception came from inside its own constructor. This is the
        # only window left to learn anything from it, and the only place
        # that stops it leaking on the host forever.
        #
        # host_port (set on `err` by open_sandbox_workspace, if that's where
        # this came from) scopes the search to a container this attempt
        # could actually have started — see _find_orphaned_sandbox_container's
        # docstring. Without it, this branch used to `docker rm -f` the
        # single newest agent-server-* container on the whole host with no
        # check that it belonged to this attempt at all — on any host ever
        # running more than one of these at once, that is a live sibling
        # job's container, not this one's, force-killed out from under it.
        diagnostics = None
        orphan_id = _find_orphaned_sandbox_container(host_port=getattr(err, "host_port", None))
        if orphan_id:
            diagnostics = _capture_container_diagnostics(orphan_id)
            try:
                subprocess.run(
                    [os.getenv("DESIGN_AGENT_DOCKER_BIN", "docker"), "rm", "-f", orphan_id],
                    capture_output=True, timeout=10,
                )
            except Exception:
                pass

        # The raw exception text itself — not just its bucketed errorClass —
        # is the one thing that actually tells apart "permission denied on
        # the socket" / "no such host" / "API version mismatch" / a genuine
        # timeout, all of which currently collapse into the same
        # ENVIRONMENT_DOCKER_UNAVAILABLE code. Previously this text only
        # ever reached the worker container's own stdout (via
        # openhands-handler.js's `causeDetail`, console-logged and
        # discarded) — never the job row, so diagnosing a real staging
        # failure required a manual docker-logs/SSH session. Capped and
        # merged into the same diagnostics object as the docker-inspect
        # fields so it flows through the same sanitized, engineer-only path.
        diagnostics = {**(diagnostics or {}), "rawError": str(err)[:1000]}

        payload = {"status": "error", "detail": str(err)}
        if error_class:
            payload["errorClass"] = error_class
        payload["containerDiagnostics"] = diagnostics
        print(RESULT_PREFIX + json.dumps(payload))
        return 1


if __name__ == "__main__":
    sys.exit(main())
