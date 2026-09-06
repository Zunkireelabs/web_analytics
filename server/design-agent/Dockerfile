# Design Agent worker — polls execution_jobs for kind='design_generate' and
# runs each one (server/design-agent/worker.js). Distinct from the root
# Dockerfile (plain node:20-alpine) only because this one also needs a real
# Chromium + its system libraries for Playwright-driven live-site analysis
# (server/design-agent/live-analysis/capture.js) — alpine's musl libc can't
# run Playwright's Chromium build, so this uses a glibc (Debian bookworm)
# base instead.
#
# Previously also carried a Python + OpenHands SDK toolchain and a static
# `docker` CLI (to drive a sibling ghcr.io/openhands/agent-server container
# per job over a mounted /var/run/docker.sock) for the 'capability-repair'
# job mode. That was replaced 2026-08-26 by a native, no-container tool-use
# loop (server/design-agent/native-repair/) — see worker.js's
# createDispatchingHandler, which never calls into OpenHands at all anymore.
# Removed here (2026-08-27) after confirming zero live code paths still
# reference it: it was adding ~1GB+ of pip installs + a Python venv + a
# downloaded docker binary to every build for no code that ever ran, which
# is what kept exhausting the VPS's disk mid-build.
FROM node:20-bookworm-slim

# procps for `pgrep`, used by the compose healthcheck (this container has no
# HTTP endpoint to curl instead).
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps first (better layer caching — same convention as the root
# Dockerfile).
COPY package*.json ./
RUN npm ci --omit=dev

# `playwright` (package.json dependency) only installs the npm driver —
# the actual Chromium binary AND the system shared libraries it needs to
# launch (libnss3, libatk, libasound2, ...) are a separate download this
# base image doesn't have by default. Without this, capture.js's
# `chromium.launch()` fails at runtime with a missing-browser error on the
# very first job. `--with-deps` installs both the browser and its apt
# dependencies in one step; scoped to chromium only (the one browser
# capture.js launches) to keep the image smaller than the default "every
# browser" install.
#
# Invoked via `node .../cli.js` rather than `npx playwright` on purpose:
# `playwright` and the devDependency `@playwright/test` both declare a bin
# literally named `playwright`, and npm always resolves that name conflict
# in favor of `@playwright/test`'s cli.js — confirmed by inspecting
# node_modules/.bin after a full `npm ci`. The `npm ci --omit=dev` above
# strips `@playwright/test` out, and nothing takes over the `playwright`
# bin symlink for the remaining `playwright` package — it's simply absent,
# so `npx playwright` has no local binary to run and fails with
# "playwright: not found" (confirmed by reproducing `npm ci --omit=dev`
# outside Docker with this repo's real lockfile). Calling the package's own
# cli.js file directly sidesteps bin-symlink resolution entirely.
RUN node node_modules/playwright/cli.js install --with-deps chromium

# Whole server/ tree, same as the root Dockerfile's own COPY — worker.js's
# real import graph (execution-jobs.js, read.js, db.js, lib/errors.js, and
# whatever those transitively pull in) isn't worth hand-picking a subset
# for and risking a MODULE_NOT_FOUND at runtime; this is plain JS source,
# not a heavy asset. No web/ or data-analyst-agent/ — this process never
# imports either.
COPY server ./server

CMD ["node", "server/design-agent/worker.js"]
