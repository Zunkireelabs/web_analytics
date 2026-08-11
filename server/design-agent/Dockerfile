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
# Debian-slim, not Alpine (unlike the root Dockerfile) — the OpenHands SDK's
# dependency tree includes compiled binary wheels (e.g. grpcio, via
# opentelemetry's gRPC exporter) that PyPI ships as manylinux (glibc) wheels.
# Alpine's musl libc has no matching wheel for packages like that, forcing a
# from-source compile that's slow at best and a real "missing build toolchain"
# failure at worst — confirmed real on a first deploy attempt, alongside the
# backtracking issue below. Debian-slim just uses the prebuilt wheel.
FROM node:20-bookworm-slim

# python3/venv/pip for the OpenHands SDK; curl to fetch the static docker CLI
# below (no dockerd of our own — see docker-compose.yml, this is
# Docker-outside-of-Docker, not Docker-in-Docker); procps for `pgrep`, used
# by the compose healthcheck (this container has no HTTP endpoint to curl
# instead); ca-certificates for pip/https.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip procps curl ca-certificates \
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
COPY server/design-agent/python/requirements.txt ./server/design-agent/python/requirements.txt
RUN python3 -m venv server/design-agent/python/.venv \
  && server/design-agent/python/.venv/bin/pip install --no-cache-dir -r server/design-agent/python/requirements.txt

# Whole server/ tree, same as the root Dockerfile's own COPY — worker.js's
# real import graph (execution-jobs.js, read.js, db.js, lib/errors.js, and
# whatever those transitively pull in) isn't worth hand-picking a subset
# for and risking a MODULE_NOT_FOUND at runtime; this is plain JS source,
# not a heavy asset. No web/ or data-analyst-agent/ — this process never
# imports either.
COPY server ./server

CMD ["node", "server/design-agent/worker.js"]
