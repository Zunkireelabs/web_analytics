# Design Agent worker — polls execution_jobs for kind='design_generate' and
# runs each one (server/design-agent/worker.js). Distinct from the root
# Dockerfile (plain node:20-alpine, no Python/Docker) because this worker
# needs THREE runtimes in one image:
#   1. Node — runs worker.js's poll loop, the long-lived process.
#   2. Python + the OpenHands SDK — worker.js spawns design_task.py as a
#      child process per claimed job (openhands-handler.js).
#   3. The `docker` CLI — design_task.py's DockerWorkspace spins up a
#      SIBLING container (ghcr.io/openhands/agent-server) per job, talking
#      to the HOST's Docker daemon via the socket this container mounts
#      (see docker-compose.yml's design-agent-worker service — requires
#      /var/run/docker.sock:/var/run/docker.sock).
#
# This container never builds/runs anything itself beyond the Node poll
# loop + spawning python3/docker as subprocesses — no source code from a
# customer repo is ever executed IN this container, only inside the
# short-lived sibling sandbox container design_task.py starts and removes
# per job.
#
# Built FROM the official python:3.12-slim image (Debian bookworm-based,
# glibc — same manylinux-wheel-compatibility reasoning as before, still
# true), with Node installed on top via NodeSource, rather than the reverse
# (node:20-bookworm-slim + apt's python3). Bookworm's own apt repos only
# carry Python 3.11 by default; openhands-agent-server==1.41.0 requires
# Python >=3.12, confirmed as a real, fast, deterministic pip failure on a
# real deploy attempt (not a version this lockfile could have been pinned
# around — 3.12 is the actual floor). Starting from an image that already
# has the right Python major version sidesteps needing backports/deadsnakes
# to get one on top of a Node base image.
FROM python:3.12-slim-bookworm

# curl (Node's own install script + the static docker CLI below); procps for
# `pgrep`, used by the compose healthcheck (this container has no HTTP
# endpoint to curl instead); ca-certificates/gnupg for the NodeSource repo.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg procps \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Static docker CLI binary (client only, no daemon) — Debian's own docker.io
# package pulls in a full dockerd we don't want and don't run; Docker's
# official static builds are just the binaries.
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz -o /tmp/docker.tgz \
  && tar -xzf /tmp/docker.tgz -C /tmp \
  && mv /tmp/docker/docker /usr/local/bin/docker \
  && rm -rf /tmp/docker.tgz /tmp/docker

WORKDIR /app

# Node deps first (better layer caching — same convention as the root
# Dockerfile).
COPY package*.json ./
RUN npm ci --omit=dev

# Python deps into a dedicated venv (Debian's system Python is externally
# managed too — pip refuses a bare `pip install` outside one). requirements.txt
# is a full `pip freeze` lockfile (every transitive dependency pinned), not
# just the 3 top-level openhands-* packages — pip's resolver was backtracking
# through dozens of openhands-sdk/lmnr/opentelemetry releases trying to find a
# compatible combination with no pins at all, blowing well past the deploy
# workflow's 20-minute SSH timeout on a real attempt. A fully pinned lockfile
# (generated from server/design-agent/python/.venv, a known-working local
# resolution) needs zero backtracking — every version is already decided.
#
# --no-deps is required, not optional: the lockfile deliberately excludes
# browser-use and its ~21-package chain (see requirements.txt's own comment
# for the verification that this is safe for what design_task.py actually
# imports) even though openhands-tools still declares browser-use as one of
# its own required dependencies. Without --no-deps, pip checks every
# installed package's declared requirements and would reinstall browser-use
# anyway to satisfy that declared-but-unused dependency, silently undoing
# the whole trim.
COPY server/design-agent/python/requirements.txt ./server/design-agent/python/requirements.txt
RUN python3 -m venv server/design-agent/python/.venv \
  && server/design-agent/python/.venv/bin/pip install --no-cache-dir --no-deps -r server/design-agent/python/requirements.txt

# Whole server/ tree, same as the root Dockerfile's own COPY — worker.js's
# real import graph (execution-jobs.js, read.js, db.js, lib/errors.js, and
# whatever those transitively pull in) isn't worth hand-picking a subset
# for and risking a MODULE_NOT_FOUND at runtime; this is plain JS source,
# not a heavy asset. No web/ or data-analyst-agent/ — this process never
# imports either.
COPY server ./server

CMD ["node", "server/design-agent/worker.js"]
