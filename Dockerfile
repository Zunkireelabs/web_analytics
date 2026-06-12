# ---- Build stage: install deps and build the React dashboard ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:web

# ---- Runtime stage: Node serves both the API and the built dashboard ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
# App source + the built web/dist from the build stage.
COPY server ./server
COPY --from=build /app/web/dist ./web/dist

RUN chown -R node:node /app
USER node

EXPOSE 3002
# The Node server serves the dashboard and runs the daily cron in-process.
CMD ["node", "server/index.js"]
