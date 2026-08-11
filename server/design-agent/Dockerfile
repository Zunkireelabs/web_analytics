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
FROM node:20-alpine

# python3/py3-pip for the OpenHands SDK; docker-cli to talk to the mounted
# host socket (no dockerd of our own — see docker-compose.yml, this is
# Docker-outside-of-Docker, not Docker-in-Docker); procps for `pgrep`,
# used by the compose healthcheck (this container has no HTTP endpoint to
# curl instead).
RUN apk add --no-cache python3 py3-pip docker-cli procps

WORKDIR /app

# Node deps first (better layer caching — same convention as the root
# Dockerfile).
COPY package*.json ./
RUN npm ci --omit=dev

# Python deps into a dedicated venv (Alpine's system Python is externally
# managed — pip refuses a bare `pip install` outside one).
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
