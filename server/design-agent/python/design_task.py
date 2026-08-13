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

import json
import os
import re
import signal
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

        print(RESULT_PREFIX + json.dumps(result))
        return 0 if result["status"] == "ok" else 1
    except _Terminated as err:
        print(RESULT_PREFIX + json.dumps({"status": "error", "detail": str(err)}))
        return 1
    except Exception as err:  # noqa: BLE001 — any SDK/LLM/Docker failure maps to a failed job, not a crash
        print(RESULT_PREFIX + json.dumps({"status": "error", "detail": str(err)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
