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

Prints two kinds of sentinel lines the Node handler looks for:
- CONTAINER_PREFIX, as soon as the container exists — captured eagerly (the
  handler reads stdout line-by-line, not just at the end) so it still knows
  the container id even if this process is later killed outright and never
  reaches the final result line, and can issue its own `docker rm -f` as a
  backstop.
- RESULT_PREFIX, exactly once, at the end: {"status": "ok"|"error", ...},
  plus {"componentTemplates": {...}} for the component-templates mode.
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

RESULT_PREFIX = "DESIGN_AGENT_RESULT: "
CONTAINER_PREFIX = "DESIGN_AGENT_CONTAINER: "
DOCKER_IMAGE = os.getenv("DESIGN_AGENT_DOCKER_IMAGE", "ghcr.io/openhands/agent-server:latest-python")

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
        else:
            task = FIXTURE_DEMO_TASK

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
            conversation.send_message(task)
            conversation.run()

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

        print(RESULT_PREFIX + json.dumps(result))
        return 0 if result["status"] == "ok" else 1
    except _Terminated as err:
        print(RESULT_PREFIX + json.dumps({"status": "error", "detail": str(err)}))
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
        text = str(err).lower()
        if "docker" in text or "daemon" in text:
            error_class = "ENVIRONMENT_DOCKER_UNAVAILABLE"
        elif "api key" in text or "unauthorized" in text or "authentication" in text:
            error_class = "ENVIRONMENT_MODEL_AUTH"
        else:
            error_class = None
        payload = {"status": "error", "detail": str(err)}
        if error_class:
            payload["errorClass"] = error_class
        print(RESULT_PREFIX + json.dumps(payload))
        return 1


if __name__ == "__main__":
    sys.exit(main())
