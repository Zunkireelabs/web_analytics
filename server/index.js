import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import loginRouter from './routes/login.js';
import metricsRouter from './routes/metrics.js';
import agentsRouter from './routes/agents.js';
import actionCenterRouter from './routes/action-center.js';
import reportsRouter from './routes/reports.js';
import commandCenterRouter from './routes/command-center.js';
import copilotRouter from './routes/copilot.js';
import integrationsRouter from './routes/integrations.js';
import notificationsRouter from './routes/notifications.js';
import watchlistRouter from './routes/watchlist.js';
import clientsRouter from './routes/clients.js';
import growthReportRouter from './routes/growth-report.js';
import siteAuditRouter from './routes/site-audit.js';
import commoncrawlBacklinksRouter from './routes/commoncrawl-backlinks.js';
import mcpTokensRouter from './routes/mcp-tokens.js';
import mcpRouter from './routes/mcp.js';
import oauthRouter from './routes/oauth.js';
import oauthConsentRouter from './routes/oauth-consent.js';
import usersRouter from './routes/users.js';
import userInvitationsRouter from './routes/user-invitations.js';
import mcpAdminRouter from './routes/mcp-admin.js';
import systemHealthRouter from './routes/system-health.js';
import auditLogRouter from './routes/audit-log.js';
import { startCron } from './cron.js';
import { runStartupCatchup } from './job.js';
import { reapStaleAuditRuns } from './store/audit-runs.js';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.set('trust proxy', 1); // behind Traefik

// Postgres-backed session store (reuses the existing pool from db.js) —
// express-session's default MemoryStore would lose every logged-in client's
// session on every restart/deploy, which is a bigger problem now that one
// process serves multiple clients at once. Self-provisions its own "session"
// table on first run.
const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is not set'); })(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
    },
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true }));
// Mount order matters here and isn't just cosmetic: every router below gates
// itself with an unscoped `router.use(requireAuth, ...)` (no path prefix),
// so once Express hands a request to a mounted router, that router's blanket
// middleware runs before Express ever checks whether a route inside it
// actually matches the URL — a non-matching path still gets rejected there
// instead of falling through to the router that actually owns it. Any
// router gated by requirePlatformRole must therefore be mounted AFTER every
// client-facing router, or it silently 404s legitimate client requests for
// routes it has nothing to do with (confirmed live: an authenticated client
// hitting /api/growth-report was rejected by copilot.js's blanket internal
// gate before ever reaching growth-report.js, despite growth-report.js
// itself being correctly client-scoped).
app.use('/api', loginRouter);
// Fully public (no requireAuth at all, not even per-route) — parallel to
// loginRouter's own public /signup-requests. Must be mounted before any
// router with a blanket `router.use(requireAuth)` below (mcpTokensRouter,
// the internal-only block), for the same reason mcpRouter must be — an
// invitation-accept request carries no session cookie, so a blanket
// requireAuth encountered first would 401 it before this router's own
// route is ever checked.
app.use('/api', userInvitationsRouter);
// mcpRouter gates itself with requireMcpToken (bearer-token auth), which
// checks the Authorization header, not req.session — an MCP client sends
// no session cookie at all. It must be mounted before every
// requireAuth-scoped router below (they all run their blanket
// `router.use(requireAuth)` against ANY path that reaches them, per the
// hazard described above), or requireAuth intercepts a cookie-less MCP
// request and rejects it with "Not authenticated." before requireMcpToken
// ever runs (confirmed live during verification: POST /api/mcp with a
// valid bearer token still hit metricsRouter's requireAuth first and 401'd).
app.use('/api', mcpRouter);
// OAuth 2.1 surface for the client-facing "Connect" flow (see MCP-PLAN.md's
// successor, the OAuth plan) — /oauth/* and /.well-known/* are OAuth-spec
// paths at the app root, not under /api, and don't collide with any
// requireAuth-gated router's blanket middleware, so mount order relative to
// them doesn't matter beyond "before the SPA catch-all" (already true; this
// is far above it in the file).
app.use(oauthRouter);
app.use('/api', metricsRouter);
app.use('/api', agentsRouter);
app.use('/api', actionCenterRouter);
app.use('/api', reportsRouter);
app.use('/api', commandCenterRouter);
app.use('/api', growthReportRouter);
app.use('/api', siteAuditRouter);
app.use('/api', mcpTokensRouter);
// Every route in usersRouter applies requireAuth per-route, not as a
// router-wide blanket (deliberately — it mixes /internal/users, staff-only,
// with /users, tenant-scoped, and a blanket at the top would gate both
// identically) — so unlike mcpTokensRouter above, its mount position here
// is for logical grouping only, not a mount-order hazard to avoid.
app.use('/api', usersRouter);
// requireAuth-gated (session cookie) — backs the OAuth consent screen
// (web/src/pages/OAuthAuthorize.jsx). Same tier as mcpTokensRouter above;
// must still precede the internal-only block below.
app.use('/api', oauthConsentRouter);
// Internal-only (requirePlatformRole-gated) — must stay last, see above.
app.use('/api', copilotRouter);
app.use('/api', integrationsRouter);
app.use('/api', notificationsRouter);
app.use('/api', watchlistRouter);
app.use('/api', clientsRouter);
app.use('/api', commoncrawlBacklinksRouter);
app.use('/api', mcpAdminRouter);
app.use('/api', systemHealthRouter);
app.use('/api', auditLogRouter);

const port = Number(process.env.API_PORT || 3002);
const httpServer = createHttpServer(app);

// Production: serve the built dashboard (web/dist) from the same server.
// Dev: mount Vite's own dev middleware (transform + HMR) on this same
// httpServer instead, so the whole app — API + frontend, with hot-reload —
// runs as one process on one port rather than a separate `vite` process
// proxying to this one. Vite auto-discovers the project's vite.config.js
// (root vite.config.js sets `root: 'web'`) from process.cwd().
if (process.env.NODE_ENV === 'production') {
  const dist = join(here, '..', 'web', 'dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (req, res) => res.sendFile(join(dist, 'index.html')));
  }
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

app.use((err, req, res, _next) => {
  console.error('[api] error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

httpServer.listen(port, () => {
  console.log(`[server] listening on :${port}`);
  if (process.env.DISABLE_CRON !== 'true') startCron();
  // Catch up on anything missed while the machine was off/asleep (non-blocking).
  runStartupCatchup();
  // Reap any audit_runs left stuck 'running' by a previous process that
  // died/restarted mid-audit (non-blocking).
  reapStaleAuditRuns()
    .then((reaped) => { if (reaped.length) console.log(`[server] reaped ${reaped.length} stale audit run(s)`); })
    .catch((err) => console.error('[server] reapStaleAuditRuns failed:', err.message));
});
