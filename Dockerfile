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
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# chown the (still-empty) dir once, then install/copy as node directly —
# a trailing `chown -R /app` over a populated node_modules tree got slow
# enough (300s+) to blow the deploy's SSH command timeout.
RUN chown node:node /app
USER node
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev
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
