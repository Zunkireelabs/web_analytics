"""Step 6D: the real OpenHands Agent + Conversation call, run inside an
isolated DockerWorkspace container — one per job, never shared. Invoked as a
subprocess by server/design-agent/openhands-handler.js — same Node-spawns-
Python bridge already used for agents/clustering.py (see server/cron.js),
and the same LLM/Agent/Conversation shape validated in design-agent-poc's
run_poc.py (Step 1). Step 6C ran the agent directly against the local
filesystem (LocalWorkspace); this replaces that with DockerWorkspace so tool
actions execute inside a throwaway container instead of this host process.

Runs against argv[1], a throwaway temp-directory COPY of the checked-in
fixture (server/design-agent/fixtures/test-site) — never the checked-in
fixture itself, never a real tenant repository. That host directory is
bind-mounted into the container at /workspace. The task is fixed and
minimal (add one small section to one page, reusing existing styles) so
this is a controlled, low-blast-radius exercise of the real Agent +
Conversation flow, not open-ended editing.

Prints two kinds of sentinel lines the Node handler looks for:
- CONTAINER_PREFIX, as soon as the container exists — captured eagerly (the
  handler reads stdout line-by-line, not just at the end) so it still knows
  the container id even if this process is later killed outright and never
  reaches the final result line, and can issue its own `docker rm -f` as a
  backstop.
- RESULT_PREFIX, exactly once, at the end: {"status": "ok"|"error", ...}.
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

import json
import os
import signal
import sys

RESULT_PREFIX = "DESIGN_AGENT_RESULT: "
CONTAINER_PREFIX = "DESIGN_AGENT_CONTAINER: "
DOCKER_IMAGE = os.getenv("DESIGN_AGENT_DOCKER_IMAGE", "ghcr.io/openhands/agent-server:latest-python")


class _Terminated(SystemExit):
    """Raised from the SIGTERM handler so any active `with` block's __exit__
    (in particular DockerWorkspace.cleanup()) still runs on the way out."""


def _install_sigterm_handler():
    def _handler(signum, frame):  # noqa: ARG001 — signal handler signature
        raise _Terminated(f"terminated by signal {signum}")

    signal.signal(signal.SIGTERM, _handler)

TASK = (
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


def main() -> int:
    if len(sys.argv) < 2:
        print(RESULT_PREFIX + json.dumps({"status": "error", "detail": "usage: design_task.py <workspace-dir>"}))
        return 1
    workspace_dir = sys.argv[1]
    _install_sigterm_handler()

    try:
        from openhands.sdk import LLM, Agent, Conversation, Tool
        from openhands.tools.file_editor import FileEditorTool
        from openhands.tools.task_tracker import TaskTrackerTool
        from openhands.tools.terminal import TerminalTool
        from openhands.workspace.docker import DockerWorkspace

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

        # One throwaway container per job (server_image is the default
        # pre-built OpenHands agent server — not our own image), bind-mounted
        # to this job's own host temp dir so no two jobs ever share a
        # workspace, container, or host directory. `with` guarantees
        # cleanup() runs on the way out, including on the _Terminated exit
        # raised by the SIGTERM handler above.
        with DockerWorkspace(
            server_image=DOCKER_IMAGE,
            volumes=[f"{workspace_dir}:/workspace"],
            working_dir="/workspace",
        ) as workspace:
            print(CONTAINER_PREFIX + json.dumps({"container_id": workspace._container_id}))

            conversation = Conversation(agent=agent, workspace=workspace)
            conversation.send_message(TASK)
            conversation.run()

        print(RESULT_PREFIX + json.dumps({"status": "ok", "detail": "conversation.run() completed"}))
        return 0
    except _Terminated as err:
        print(RESULT_PREFIX + json.dumps({"status": "error", "detail": str(err)}))
        return 1
    except Exception as err:  # noqa: BLE001 — any SDK/LLM/Docker failure maps to a failed job, not a crash
        print(RESULT_PREFIX + json.dumps({"status": "error", "detail": str(err)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
