# ---- Build stage: install deps and build the React dashboard ----
FROM node:20-alpine AS build
WORKDIR /app
# Baked into the built SPA so the MCP-tokens "connect" snippet shows the
# canonical MCP subdomain directly instead of this app's own origin — see
# web/src/components/McpTokensCard.jsx. Passed as a compose build arg.
ARG VITE_MCP_ORIGIN
ENV VITE_MCP_ORIGIN=${VITE_MCP_ORIGIN}
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:web

# ---- Runtime stage: Node serves both the API and the built dashboard ----
# bookworm-slim, not alpine: this image runs the in-process daily cron (see
# CMD below), and two of that cron's detection agents — font-consistency and
# visual-quality — launch a real Playwright Chromium. Alpine's musl libc
# cannot run Playwright's Chromium build at all, which is the same reason
# server/design-agent/Dockerfile already uses this base.
#
# That mismatch is not theoretical. Both agents errored on 100% of their runs
# against the only real site — chromium.launch() failing instantly on a
# browser that was never installed here — and because the stored reason went
# through safeMessage ("this run did not complete"), it read as an agent bug
# rather than a missing dependency for a month.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Shared, root-owned browser location instead of the default per-user
# ~/.cache/ms-playwright. Installing as root into a path the `node` user can
# read avoids a `chown -R` over the browser tree — the same trailing-chown
# cost documented below, which browsers (several hundred MB) would make
# worse, not better.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# chown the (still-empty) dir once, then install/copy as node directly —
# a trailing `chown -R /app` over a populated node_modules tree got slow
# enough (300s+) to blow the deploy's SSH command timeout.
RUN chown node:node /app
USER node
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

# The npm `playwright` dependency installed above is only the driver — the
# Chromium binary and the system libraries it needs to launch (libnss3,
# libatk, libasound2, ...) are a separate download. Scoped to chromium alone
# (the one browser capture.js launches) rather than the default all-browsers
# install, to keep this image's growth as small as this can be: the VPS has
# run out of disk mid-build before (see server/design-agent/Dockerfile).
#
# Invoked as `node node_modules/playwright/cli.js` rather than `npx
# playwright` for the reason documented at length in that same file: both
# `playwright` and the devDependency `@playwright/test` declare a bin named
# `playwright`, npm resolves the conflict in favour of `@playwright/test`,
# and `npm ci --omit=dev` then strips that away leaving no `playwright` bin
# at all. Calling the package's own cli.js sidesteps bin resolution entirely.
#
# Needs root for --with-deps' apt-get; back to `node` immediately after, with
# the browser tree left world-readable so the unprivileged runtime user can
# launch it.
#
# `install chromium` downloads TWO browser builds: full Chromium (624MB) and
# chromium-headless-shell (334MB). This codebase has exactly one launch site
# — design-agent/live-analysis/capture.js's launchBrowser(), used by the
# design agent, font-consistency and visual-quality alike — and it is always
# `headless: true`, which Playwright resolves to the headless shell. Full
# Chromium is never executed, so it is deleted in the SAME layer as the
# install (the bytes then never land in the image at all, rather than being
# masked by a later layer). Verified by deleting it in this image and
# re-running a real launch + getComputedStyle + screenshot.
#
# Keeps ~624MB off an image that has to live on a VPS with a documented
# history of running out of disk mid-build (see server/design-agent/
# Dockerfile). If a headful launch is ever genuinely needed, drop this rm —
# do not add a second browser install.
#
# The risk accepted is a future Playwright changing which binary `headless:
# true` resolves to. That failure is bounded and loud: it surfaces through
# agents/lib/browser-preflight.js as a plain "the headless browser is not
# available on this server", not as a silent month of empty runs — the exact
# failure mode that made this line necessary in the first place.
USER root
RUN node node_modules/playwright/cli.js install --with-deps chromium \
  && rm -rf /ms-playwright/chromium-[0-9]* \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/*
USER node
# App source + the built web/dist from the build stage. mcp-server/ is
# included here too — the analytics-mcp compose service overrides CMD to run
# it (node mcp-server/index.js) from this same image, so both services stay
# in lockstep without a second Dockerfile.
COPY --chown=node:node server ./server
COPY --chown=node:node mcp-server ./mcp-server
COPY --chown=node:node --from=build /app/web/dist ./web/dist

EXPOSE 3002
# The Node server serves the dashboard and runs the daily cron in-process.
CMD ["node", "server/index.js"]
