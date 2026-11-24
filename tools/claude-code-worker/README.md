# Claude Code worker

A small program that runs on a laptop. It lets **Claude Code write the AI text for fixes** (titles, FAQs, expanded sections, blog drafts) instead of a paid AI API.

```
server ── puts the question in a queue ──►  this worker  ── runs Claude Code ──► text ──► server
server then does everything else: its own quality and design checks, the file change and the pull request.
```

The worker only ever receives a prompt and returns text. It has **no access to any repository, GitHub or the database**. The laptop connects *out* to the server; nothing connects in.

## What it needs

On the **server** (production environment, set by a person with deploy access):

| Variable | Meaning |
|---|---|
| `LLM_WORKER_TOKEN` | A long random secret. Until it is set, every worker endpoint answers 404, so the feature does not exist. |
| `LLM_WORKER_MODE=on` | Fix generators send their AI calls to the worker. Off by default; deploying the code changes nothing by itself. |
| `LLM_WORKER_FALLBACK` | `none` (default): with no worker connected the call fails as "AI provider unavailable" and is retried on the next pass. `api`: it goes to the paid API as before. |
| `LLM_WORKER_WAIT_MS` | How long one call waits for the worker (default 10 minutes, minimum 30 seconds). |

Migration `267_llm_worker.sql` creates the queue (applied on deploy).

On the **laptop**:

1. Node 20+ and Claude Code installed (`claude`).
2. A **separate Claude Code profile for the worker**, so it never reads your own instructions, memory or settings. Sign it in once:
   ```
   CLAUDE_CONFIG_DIR="$HOME/.superrank-worker/claude" claude
   # then type /login and finish signing in, then /exit
   ```
3. The token, in the macOS keychain (or as `LLM_WORKER_TOKEN` in the environment):
   ```
   security add-generic-password -s superrank-worker -a worker -w '<token>'
   ```

## Run

```
SUPERRANK_URL=https://<your-server> node tools/claude-code-worker/worker.mjs
```

It prints one line per event and never any prompt or page content:

```
10:42:07  #12 meta-title (site 1) picked up
10:42:21  #12 done in 14.2s (480 characters), 910 tokens
```

Stop with Ctrl+C: it finishes what it is writing (up to a minute), gives back anything unfinished, and exits.

| Variable | Default |
|---|---|
| `WORKER_CONCURRENCY` | 2 (max 4) requests at a time |
| `WORKER_TIMEOUT_MS` | 240000: longest one request may take |
| `WORKER_MODEL` | Claude Code's default |
| `WORKER_CLAUDE_CONFIG_DIR` | `~/.superrank-worker/claude` |
| `CLAUDE_BIN` | `claude` |

## How each Claude Code call is made

`claude -p --output-format json --tools "" --no-session-persistence --setting-sources "" --disable-slash-commands --strict-mcp-config --system-prompt-file <file>`, run in an **empty temporary directory**, with the prompt on stdin. It is a plain text writer: no file, shell or web tools, nothing saved, none of your account's settings.

One thing cannot be switched off: Claude Code still tells the model which account it is signed in as (the email). Use a dedicated account for the worker if that matters.

## When things go wrong

- **Laptop closed or asleep:** requests nobody answers expire; the server treats it as "AI provider unavailable" (never as a generator defect), nothing is closed or lost, and the work is retried on the next pass.
- **Claude usage limit or busy service:** the request is given back to the queue and the worker rests 10 minutes. It does not retry in a loop.
- **Not signed in:** the worker stops and prints the exact command to fix it.
- **Wrong token / feature not enabled on the server:** the worker stops with the reason and a non-zero exit code.
- **Network drop:** it retries with growing waits (2s up to 1 minute) and carries on.

Usage: each request is one Claude Code call on your account. Check your plan's limits before relying on it for a full day's volume.
