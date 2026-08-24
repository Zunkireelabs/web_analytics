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

import os
import sys
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


if __name__ == "__main__":
    unittest.main()
