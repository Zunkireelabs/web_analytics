"""Regression tests for design_task.py's Docker-outside-of-Docker sandbox
networking fix (2026-08-24). No pytest dependency — this repo has none
installed for the Python side, so these use stdlib unittest, run via:

    server/design-agent/python/.venv/bin/python -m unittest \
        server.design-agent.python.design_task_test -v

(or `python -m unittest design_task_test` from inside python/).

Scope is deliberately narrow: the port/host wiring in
sandbox_workspace_kwargs(), and that _capture_container_diagnostics (the
existing container-crash diagnostics path) is untouched by that change. The
DockerWorkspace class itself and classifyFailure() are exercised by other
suites (openhands-handler.test.js, failure-classification.test.js) — not
duplicated here.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import design_task  # noqa: E402


class SandboxWorkspaceKwargsTest(unittest.TestCase):
    def test_passes_the_reserved_port_finder_result_as_host_port(self):
        kwargs = design_task.sandbox_workspace_kwargs(port_finder=lambda: 34567)
        self.assertEqual(kwargs["host_port"], 34567)

    def test_health_url_host_is_not_127_0_0_1(self):
        # The exact bug: DockerWorkspace's own default host
        # (http://127.0.0.1:{port}) is unreachable from inside a
        # Docker-outside-of-Docker parent container — confirmed by direct
        # reproduction of that topology. This asserts we never fall back to
        # that default.
        kwargs = design_task.sandbox_workspace_kwargs(port_finder=lambda: 34567)
        self.assertNotIn("127.0.0.1", kwargs["host"])
        self.assertNotIn("localhost", kwargs["host"])

    def test_health_url_uses_host_docker_internal_by_default(self):
        kwargs = design_task.sandbox_workspace_kwargs(port_finder=lambda: 34567)
        self.assertEqual(kwargs["host"], "http://host.docker.internal:34567")

    def test_host_is_overridable_for_non_dind_deployments(self):
        # A deployment that isn't Docker-outside-of-Docker (design_task.py
        # run directly against a real host daemon) can still reach the
        # sibling container over loopback — this must stay possible via env,
        # not hardcoded to host.docker.internal.
        original = os.environ.get("DESIGN_AGENT_SANDBOX_HOST")
        try:
            os.environ["DESIGN_AGENT_SANDBOX_HOST"] = "127.0.0.1"
            import importlib
            reloaded = importlib.reload(design_task)
            kwargs = reloaded.sandbox_workspace_kwargs(port_finder=lambda: 9999)
            self.assertEqual(kwargs["host"], "http://127.0.0.1:9999")
        finally:
            if original is None:
                os.environ.pop("DESIGN_AGENT_SANDBOX_HOST", None)
            else:
                os.environ["DESIGN_AGENT_SANDBOX_HOST"] = original
            importlib.reload(design_task)

    def test_no_site_or_tenant_identifier_anywhere_in_the_kwargs(self):
        # This wiring is deployment-global (one env var), never per-site —
        # nothing here should ever vary by site_id, domain, or client name.
        kwargs = design_task.sandbox_workspace_kwargs(port_finder=lambda: 34567)
        blob = repr(kwargs)
        for forbidden in ("zunkiree", "site_id", "client", "tenant"):
            self.assertNotIn(forbidden, blob.lower())

    def test_a_port_finder_that_found_nothing_fails_loudly_not_silently(self):
        # find_available_tcp_port() returns -1 (its own documented sentinel,
        # not an exception) when every candidate port was taken. Silently
        # passing -1 through to `docker run -p -1:8000` would fail with a
        # confusing Docker CLI error instead of a clear one.
        with self.assertRaises(RuntimeError):
            design_task.sandbox_workspace_kwargs(port_finder=lambda: -1)


class ContainerDiagnosticsUnaffectedTest(unittest.TestCase):
    """The sandbox-networking fix touches only sandbox_workspace_kwargs() and
    the DockerWorkspace(...) call site — this proves the pre-existing
    container-crash diagnostics capture (a separate code path, used when
    conversation.run() fails after the container already started) is
    untouched."""

    def test_capture_container_diagnostics_still_exists_and_is_callable(self):
        self.assertTrue(callable(design_task._capture_container_diagnostics))

    def test_missing_docker_binary_is_reported_as_an_inspect_error_not_a_crash(self):
        result = design_task._capture_container_diagnostics(
            "fake-container-id", docker_bin="/definitely/not/a/real/docker/binary"
        )
        self.assertIsInstance(result, dict)
        self.assertTrue(result.get("inspectError") or result.get("stateError"))


class ClassifySandboxConstructionErrorTest(unittest.TestCase):
    """Regression coverage for the 2026-08-24 finding that a real staging
    verification job (1354) reported AGENT_SANDBOX_DOCKER_UNAVAILABLE with
    the exact same duration/shape as every pre-fix failure — meaning the
    generic DockerWorkspace()-construction exception handler was very likely
    never reaching the health-check path this session's earlier fix
    targeted at all, since only "docker"/"daemon" text was ever recognized
    here and the SDK's own health-check-timeout wording contains neither."""

    def test_docker_daemon_unreachable_is_still_recognized(self):
        self.assertEqual(
            design_task.classify_sandbox_construction_error("Docker is not available. Please install and start Docker Desktop/daemon."),
            "ENVIRONMENT_DOCKER_UNAVAILABLE",
        )

    def test_model_auth_is_still_recognized(self):
        self.assertEqual(
            design_task.classify_sandbox_construction_error("401 Unauthorized: invalid api key"),
            "ENVIRONMENT_MODEL_AUTH",
        )

    def test_health_check_timeout_is_no_longer_unclassified(self):
        # The exact SDK wording (openhands/workspace/docker/workspace.py's
        # _wait_for_health) — contains neither "docker" nor "daemon", which
        # is exactly why this fell through to error_class=None before this
        # branch existed.
        self.assertEqual(
            design_task.classify_sandbox_construction_error("Container failed to become healthy in time"),
            "ENVIRONMENT_CONTAINER_UNHEALTHY",
        )

    def test_container_stopped_unexpectedly_is_no_longer_unclassified(self):
        self.assertEqual(
            design_task.classify_sandbox_construction_error("Container stopped unexpectedly. Logs:\nsome stdout\nsome stderr"),
            "ENVIRONMENT_CONTAINER_UNHEALTHY",
        )

    def test_an_unrecognized_message_stays_unclassified_not_guessed(self):
        self.assertIsNone(design_task.classify_sandbox_construction_error("some completely novel SDK failure"))

    def test_docker_wording_wins_over_container_wording_when_both_present(self):
        # A docker-daemon-unreachable message could incidentally mention
        # "container" too; the more specific, more actionable class must win.
        self.assertEqual(
            design_task.classify_sandbox_construction_error("Failed to run docker container: permission denied"),
            "ENVIRONMENT_DOCKER_UNAVAILABLE",
        )


class ClassifyContainerRunErrorTest(unittest.TestCase):
    """Regression coverage for job 1742 on staging: a container that exited
    cleanly (exitCode 0, not OOM-killed) and was already auto-removed
    (--rm) by the time its logs were requested reported "Container stopped
    unexpectedly...Error response from daemon: can not get logs from
    container which is dead or marked for removal" — and the old handler's
    "docker"/"daemon" check ran before its "container" check, so this
    routine Docker CLI wording sent it to ENVIRONMENT_DOCKER_UNAVAILABLE
    instead of ENVIRONMENT_CONTAINER_CRASHED, five times in a row."""

    def test_container_stopped_unexpectedly_wins_even_when_daemon_is_mentioned(self):
        self.assertEqual(
            design_task.classify_container_run_error(
                "Container stopped unexpectedly. Logs:\n\n"
                "Error response from daemon: can not get logs from container which is dead or marked for removal"
            ),
            "ENVIRONMENT_CONTAINER_CRASHED",
        )

    def test_no_such_container_wins_even_when_docker_is_mentioned(self):
        self.assertEqual(
            design_task.classify_container_run_error("No such container: docker could not find it"),
            "ENVIRONMENT_CONTAINER_CRASHED",
        )

    def test_genuine_docker_unavailable_is_still_recognized(self):
        self.assertEqual(
            design_task.classify_container_run_error("Docker is not available. Please install and start Docker Desktop/daemon."),
            "ENVIRONMENT_DOCKER_UNAVAILABLE",
        )

    def test_model_auth_is_still_recognized(self):
        self.assertEqual(
            design_task.classify_container_run_error("401 Unauthorized: invalid api key"),
            "ENVIRONMENT_MODEL_AUTH",
        )

    def test_an_unrecognized_message_stays_unclassified_not_guessed(self):
        self.assertIsNone(design_task.classify_container_run_error("some completely novel SDK failure"))


class FindOrphanedSandboxContainerTest(unittest.TestCase):
    """The container DockerWorkspace() itself started (if `docker run`
    succeeded before _wait_for_health() failed) is never cleaned up by the
    SDK in that case — its cleanup() never runs, since the exception comes
    from inside its own constructor. Without this, every health-check
    timeout would leak one sandbox container on the host forever."""

    def test_a_missing_docker_binary_returns_none_rather_than_raising(self):
        result = design_task._find_orphaned_sandbox_container(docker_bin="/definitely/not/a/real/docker/binary")
        self.assertIsNone(result)


class ContainerIpOnNetworkTest(unittest.TestCase):
    def test_a_missing_docker_binary_returns_none_rather_than_raising(self):
        result = design_task._container_ip_on_network(
            "fake-container-id", "hosting", docker_bin="/definitely/not/a/real/docker/binary"
        )
        self.assertIsNone(result)


class TryStopContainerTest(unittest.TestCase):
    def test_a_missing_docker_binary_never_raises(self):
        # Called from failure branches that are already unwinding an
        # exception — a cleanup failure here must never replace or mask it.
        design_task._try_stop_container("fake-container-id", docker_bin="/definitely/not/a/real/docker/binary")


class _FakeDockerWorkspace:
    """Stands in for the real DockerWorkspace in OpenSandboxWorkspaceTest —
    never touches Docker or the OpenHands SDK."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self._container_id = "docker-workspace-container-id"

    def cleanup(self):
        self.cleanup_called = True


class _FailingDockerWorkspace:
    def __init__(self, **kwargs):
        raise RuntimeError("Container failed to become healthy in time")


class _DockerUnavailableDockerWorkspace:
    def __init__(self, **kwargs):
        raise RuntimeError("Docker is not available. Please install and start Docker Desktop/daemon.")


class _FakeRemoteWorkspace:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.alive = True


class OpenSandboxWorkspaceTest(unittest.TestCase):
    """2026-08-24: proven live (by running the real image locally, in the
    real Docker-outside-of-Docker topology, with the real fix) that
    DockerWorkspace() itself works correctly given a working
    host.docker.internal path — yet a real staging job still failed the
    same way, meaning something specific to that one VPS (most likely its
    firewall) blocks the host-published-port path even when the sandbox
    container is completely healthy. This is the fallback: reach the same
    already-running sibling container directly by its own IP on a shared
    Docker network instead — traffic that never crosses into the host's own
    network namespace, so a host firewall's INPUT rules do not apply to it.
    All Docker/SDK interaction is dependency-injected or monkeypatched here
    — no real Docker daemon needed."""

    def test_the_normal_path_returns_a_docker_workspace_unchanged_when_it_succeeds(self):
        workspace, cleanup, container_id, used_fallback = design_task.open_sandbox_workspace(
            docker_workspace_cls=_FakeDockerWorkspace,
            remote_workspace_cls=_FakeRemoteWorkspace,
            server_image="fake-image", volumes=[], working_dir="/workspace",
            port_finder=lambda: 34567, network="hosting",
        )
        self.assertIsInstance(workspace, _FakeDockerWorkspace)
        self.assertEqual(container_id, "docker-workspace-container-id")
        self.assertFalse(used_fallback)
        cleanup()
        self.assertTrue(workspace.cleanup_called)

    def test_a_failure_unrelated_to_the_health_check_is_never_retried_via_fallback(self):
        # Docker itself being unreachable means there is no running sibling
        # to fall back to in the first place — retrying via the fallback
        # path here would just be a confusing second failure mode for the
        # same root cause.
        with self.assertRaises(RuntimeError):
            design_task.open_sandbox_workspace(
                docker_workspace_cls=_DockerUnavailableDockerWorkspace,
                remote_workspace_cls=_FakeRemoteWorkspace,
                server_image="fake-image", volumes=[], working_dir="/workspace",
                port_finder=lambda: 34567, network="hosting",
            )

    def test_no_network_configured_means_no_fallback_attempted(self):
        # network=None (the default — nothing set DESIGN_AGENT_SANDBOX_NETWORK)
        # means there is no shared network to find the sibling's IP on, so
        # the original error must propagate rather than silently swallowing it.
        with self.assertRaises(RuntimeError):
            design_task.open_sandbox_workspace(
                docker_workspace_cls=_FailingDockerWorkspace,
                remote_workspace_cls=_FakeRemoteWorkspace,
                server_image="fake-image", volumes=[], working_dir="/workspace",
                port_finder=lambda: 34567, network=None,
            )

    def test_a_health_check_failure_with_no_discoverable_orphan_still_raises(self):
        original = design_task._find_orphaned_sandbox_container
        design_task._find_orphaned_sandbox_container = lambda *a, **k: None
        try:
            with self.assertRaises(RuntimeError):
                design_task.open_sandbox_workspace(
                    docker_workspace_cls=_FailingDockerWorkspace,
                    remote_workspace_cls=_FakeRemoteWorkspace,
                    server_image="fake-image", volumes=[], working_dir="/workspace",
                    port_finder=lambda: 34567, network="hosting",
                )
        finally:
            design_task._find_orphaned_sandbox_container = original

    def test_a_health_check_failure_with_an_orphan_but_no_ip_still_raises(self):
        # Regression: this branch used to re-raise without ever stopping the
        # orphan it had just found — leaking a real running container every
        # time this specific failure occurred.
        original_find = design_task._find_orphaned_sandbox_container
        original_ip = design_task._container_ip_on_network
        original_stop = design_task._try_stop_container
        stopped = []
        design_task._find_orphaned_sandbox_container = lambda *a, **k: "orphan-id"
        design_task._container_ip_on_network = lambda *a, **k: None
        design_task._try_stop_container = lambda cid, **k: stopped.append(cid)
        try:
            with self.assertRaises(RuntimeError):
                design_task.open_sandbox_workspace(
                    docker_workspace_cls=_FailingDockerWorkspace,
                    remote_workspace_cls=_FakeRemoteWorkspace,
                    server_image="fake-image", volumes=[], working_dir="/workspace",
                    port_finder=lambda: 34567, network="hosting",
                )
            self.assertEqual(stopped, ["orphan-id"], "the orphan found but never reachable must still be stopped, not leaked")
        finally:
            design_task._find_orphaned_sandbox_container = original_find
            design_task._container_ip_on_network = original_ip
            design_task._try_stop_container = original_stop

    def test_a_health_check_failure_with_a_reachable_orphan_falls_back_successfully(self):
        original_find = design_task._find_orphaned_sandbox_container
        original_ip = design_task._container_ip_on_network
        design_task._find_orphaned_sandbox_container = lambda *a, **k: "orphan-id"
        design_task._container_ip_on_network = lambda *a, **k: "172.20.0.5"
        try:
            workspace, cleanup, container_id, used_fallback = design_task.open_sandbox_workspace(
                docker_workspace_cls=_FailingDockerWorkspace,
                remote_workspace_cls=_FakeRemoteWorkspace,
                server_image="fake-image", volumes=[], working_dir="/workspace",
                port_finder=lambda: 34567, network="hosting",
            )
            self.assertIsInstance(workspace, _FakeRemoteWorkspace)
            self.assertEqual(workspace.kwargs["host"], "http://172.20.0.5:8000")
            self.assertEqual(container_id, "orphan-id")
            self.assertTrue(used_fallback)
        finally:
            design_task._find_orphaned_sandbox_container = original_find
            design_task._container_ip_on_network = original_ip

    def test_a_reachable_orphan_that_never_becomes_alive_still_raises_rather_than_hanging_forever(self):
        # Same regression as the no-IP case above, for the other leak path:
        # found the orphan, got its IP, but it never actually answers health
        # checks within the timeout — still not allowed to leak it.
        class _NeverAliveRemoteWorkspace:
            def __init__(self, **kwargs):
                self.alive = False

        original_find = design_task._find_orphaned_sandbox_container
        original_ip = design_task._container_ip_on_network
        original_stop = design_task._try_stop_container
        stopped = []
        design_task._find_orphaned_sandbox_container = lambda *a, **k: "orphan-id"
        design_task._container_ip_on_network = lambda *a, **k: "172.20.0.5"
        design_task._try_stop_container = lambda cid, **k: stopped.append(cid)
        try:
            with self.assertRaises(RuntimeError):
                design_task.open_sandbox_workspace(
                    docker_workspace_cls=_FailingDockerWorkspace,
                    remote_workspace_cls=_NeverAliveRemoteWorkspace,
                    server_image="fake-image", volumes=[], working_dir="/workspace",
                    port_finder=lambda: 34567, network="hosting",
                    alive_timeout=0.05,
                )
            self.assertEqual(stopped, ["orphan-id"], "an orphan that never becomes alive must still be stopped, not leaked")
        finally:
            design_task._find_orphaned_sandbox_container = original_find
            design_task._container_ip_on_network = original_ip
            design_task._try_stop_container = original_stop


class BuildCapabilityRepairTaskTest(unittest.TestCase):
    """Generic multi-tenant task builder for the 'architectural-gap' case —
    every identifier in the constructed prompt must come from `payload`,
    never a hardcoded tenant/field/generator name."""

    def test_names_the_real_generator_field_and_paths_from_payload_only(self):
        task = design_task.build_capability_repair_task({
            "generatorId": "some-generator", "valueKey": "someValueKey",
            "templatePath": "src/templates/widget.njk", "templateSource": "<div>{{ widget.title }}</div>",
            "dataFilePath": "src/_data/widgets.js", "dataFileSource": "export default [{id: 'a', title: 'A'}]",
        })
        self.assertIn("some-generator", task)
        self.assertIn("someValueKey", task)
        self.assertIn("src/templates/widget.njk", task)
        self.assertIn("src/_data/widgets.js", task)
        self.assertIn("<div>{{ widget.title }}</div>", task)
        self.assertNotIn("zunkiree", task.lower())

    def test_includes_real_convention_examples_when_provided_instead_of_inventing_one(self):
        task = design_task.build_capability_repair_task({
            "generatorId": "g", "valueKey": "v", "templatePath": "t.njk", "dataFilePath": "d.js",
            "conventionExamples": [{"path": "other.njk", "snippet": "{% if x.v %}{{ x.v | safe }}{% endif %}"}],
        })
        self.assertIn("other.njk", task)
        self.assertIn("{% if x.v %}{{ x.v | safe }}{% endif %}", task)
        self.assertNotIn("has no existing example", task)

    def test_falls_back_to_the_documented_minimal_shape_when_no_convention_exists_anywhere(self):
        task = design_task.build_capability_repair_task({
            "generatorId": "g", "valueKey": "v", "templatePath": "t.njk", "dataFilePath": "d.js",
            "conventionExamples": [],
        })
        self.assertIn("has no existing example", task)
        self.assertIn("server/generators/g.js", task)

    def test_instructs_scope_limited_to_exactly_the_two_named_files(self):
        task = design_task.build_capability_repair_task({
            "generatorId": "g", "valueKey": "v", "templatePath": "only/this.njk", "dataFilePath": "only/this.js",
        })
        self.assertIn("Only touch only/this.njk and only/this.js", task)


class DetectBuildCommandTest(unittest.TestCase):
    """Never assumes a package manager or command — reads the tenant's own
    package.json, generic across every tenant's own toolchain choice."""

    def _make_repo(self, scripts=None, lockfile=None):
        d = tempfile.mkdtemp()
        pkg = {"name": "x"}
        if scripts is not None:
            pkg["scripts"] = scripts
        with open(os.path.join(d, "package.json"), "w") as f:
            json.dump(pkg, f)
        if lockfile:
            open(os.path.join(d, lockfile), "w").close()
        return d

    def test_no_package_json_returns_none_not_a_guess(self):
        d = tempfile.mkdtemp()
        self.assertIsNone(design_task._detect_build_command(d))

    def test_no_build_script_returns_none(self):
        d = self._make_repo(scripts={"start": "node index.js"})
        self.assertIsNone(design_task._detect_build_command(d))

    def test_npm_is_the_default_when_no_lockfile_hints_otherwise(self):
        d = self._make_repo(scripts={"build": "eleventy"})
        self.assertEqual(design_task._detect_build_command(d), ["npm", "run", "build"])

    def test_detects_pnpm_from_its_own_lockfile(self):
        d = self._make_repo(scripts={"build": "eleventy"}, lockfile="pnpm-lock.yaml")
        self.assertEqual(design_task._detect_build_command(d), ["pnpm", "run", "build"])

    def test_detects_yarn_from_its_own_lockfile(self):
        d = self._make_repo(scripts={"build": "eleventy"}, lockfile="yarn.lock")
        self.assertEqual(design_task._detect_build_command(d), ["yarn", "build"])


class SnapshotSpecificFilesTest(unittest.TestCase):
    def test_snapshots_only_the_named_files_not_the_whole_repo(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "a.js"), "w") as f:
            f.write("const a = 1;")
        with open(os.path.join(d, "b.js"), "w") as f:
            f.write("const b = 2;")
        snap = design_task._snapshot_specific_files(d, ["a.js"])
        self.assertEqual(snap, {"a.js": "const a = 1;"})
        self.assertNotIn("b.js", snap)

    def test_a_file_that_does_not_exist_yet_records_none_not_an_error(self):
        d = tempfile.mkdtemp()
        snap = design_task._snapshot_specific_files(d, ["never-created.js"])
        self.assertEqual(snap, {"never-created.js": None})


class ValidateCapabilityRepairTest(unittest.TestCase):
    """This is the enforcement point for 'only affects the intended page
    family' and 'validate with the client's own build' — never trusts the
    agent's own self-report."""

    def test_no_changed_files_is_not_a_validated_repair(self):
        result = design_task._validate_capability_repair("/tmp", "t.njk", "d.js", [])
        self.assertFalse(result["ok"])

    def test_a_file_outside_the_two_named_paths_fails_validation(self):
        result = design_task._validate_capability_repair(
            "/tmp", "t.njk", "d.js",
            [{"path": "t.njk", "newContent": "x"}, {"path": "unrelated/other.js", "newContent": "y"}],
        )
        self.assertFalse(result["ok"])
        self.assertIn("unrelated/other.js", result["output"])

    def test_invalid_json_data_file_fails_validation(self):
        result = design_task._validate_capability_repair(
            "/tmp", "t.njk", "d.json",
            [{"path": "d.json", "newContent": "{not valid json"}],
        )
        self.assertFalse(result["ok"])

    def test_no_build_script_in_repo_fails_honestly_rather_than_guessing_a_command(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "t.njk"), "w") as f:
            f.write("<div></div>")
        result = design_task._validate_capability_repair(
            d, "t.njk", "d.js", [{"path": "t.njk", "newContent": "<div>x</div>"}],
        )
        self.assertFalse(result["ok"])
        self.assertIn("build", result["output"])

    def test_a_successful_build_validates_the_repair(self):
        # A real (but dependency-free) package.json + lockfile so `npm ci`
        # completes near-instantly with no network access, keeping this
        # test fast and hermetic while still exercising the real install ->
        # build sequence, not a mocked one.
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "package.json"), "w") as f:
            json.dump({"name": "fixture", "version": "1.0.0", "scripts": {"build": "echo built-ok"}}, f)
        with open(os.path.join(d, "package-lock.json"), "w") as f:
            json.dump({
                "name": "fixture", "version": "1.0.0", "lockfileVersion": 3,
                "packages": {"": {"name": "fixture", "version": "1.0.0"}},
            }, f)
        with open(os.path.join(d, "t.njk"), "w") as f:
            f.write("<div></div>")
        result = design_task._validate_capability_repair(
            d, "t.njk", "d.js", [{"path": "t.njk", "newContent": "<div>x</div>"}],
        )
        self.assertTrue(result["ok"], result["output"])
        self.assertIn("built-ok", result["output"])


class DetectInstallCommandTest(unittest.TestCase):
    def _make_repo(self, lockfile=None):
        d = tempfile.mkdtemp()
        if lockfile:
            open(os.path.join(d, lockfile), "w").close()
        return d

    def test_npm_ci_is_the_default_when_no_lockfile_hints_otherwise(self):
        self.assertEqual(design_task._detect_install_command(self._make_repo()), ["npm", "ci"])

    def test_detects_pnpm_from_its_own_lockfile(self):
        d = self._make_repo(lockfile="pnpm-lock.yaml")
        self.assertEqual(design_task._detect_install_command(d), ["pnpm", "install", "--frozen-lockfile"])

    def test_detects_yarn_from_its_own_lockfile(self):
        d = self._make_repo(lockfile="yarn.lock")
        self.assertEqual(design_task._detect_install_command(d), ["yarn", "install", "--frozen-lockfile"])


if __name__ == "__main__":
    unittest.main()
