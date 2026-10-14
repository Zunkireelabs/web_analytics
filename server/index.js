import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { logInternal } from './lib/errors.js';
import loginRouter from './routes/login.js';
import metricsRouter from './routes/metrics.js';
import agentsRouter from './routes/agents.js';
import actionCenterRouter from './routes/action-center.js';
import reportsRouter from './routes/reports.js';
import commandCenterRouter from './routes/command-center.js';
import copilotRouter from './routes/copilot.js';
import assistantRouter from './routes/assistant.js';
import integrationsRouter from './routes/integrations.js';
import notificationsRouter from './routes/notifications.js';
import watchlistRouter from './routes/watchlist.js';
import clientsRouter from './routes/clients.js';
import dataAnalystRouter from './routes/dataAnalyst.js';
import keywordsRouter from './routes/keywords.js';
import growthReportRouter from './routes/growth-report.js';
import siteAuditRouter from './routes/site-audit.js';
import commoncrawlBacklinksRouter from './routes/commoncrawl-backlinks.js';
import mcpTokensRouter from './routes/mcp-tokens.js';
import { apiBridgeRouter, rootBridgeRouter } from './routes/mcp-bridge.js';
import webhooksRouter from './routes/webhooks.js';
import crmWebhookRouter from './routes/crm-webhook.js';
import trialSignupRouter from './routes/trial-signup.js';
import oauthConsentRouter from './routes/oauth-consent.js';
import usersRouter from './routes/users.js';
import userInvitationsRouter from './routes/user-invitations.js';
import mcpAdminRouter from './routes/mcp-admin.js';
import systemHealthRouter from './routes/system-health.js';
import auditLogRouter from './routes/audit-log.js';
import opsCenterRouter from './routes/ops-center.js';
import dataAgentRouter from './routes/data-agent.js';
import demandRouter from './routes/demand.js';
import { startCron } from './cron.js';
import { runStartupCatchup, reconcileBlockedRecommendationsOnStartup } from './job.js';
import { reapStaleAuditRuns, countAuditRunsByTrigger } from './store/audit-runs.js';
import { startFullSiteAudit } from './agents/lib/bulk-audit.js';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();

// `verify` stashes the exact raw bytes on req.rawBody as a side effect of
// parsing — needed by routes/webhooks.js, which must HMAC-verify GitHub's
// signature against the untouched body, not a re-serialized JSON.stringify
// of the parsed object (key order/whitespace differences would break the
// signature). Cheap enough to do unconditionally for every request rather
// than special-casing just the webhook route's body parsing.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
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
// the internal-only block), for the same reason apiBridgeRouter must be —
// an invitation-accept request carries no session cookie, so a blanket
// requireAuth encountered first would 401 it before this router's own
// route is ever checked.
app.use('/api', userInvitationsRouter);
// POST /api/mcp and the OAuth 2.1 surface (/oauth/*, /.well-known/*) now
// live on their own standalone process (mcp-server/index.js), on their own
// subdomain (MCP_DOMAIN) — see the plan: "Split the MCP server onto its own
// subdomain." apiBridgeRouter/rootBridgeRouter (server/routes/mcp-bridge.js)
// are a temporary compatibility bridge: anything still hitting the old
// paths on this app gets a 307 redirect to the new domain instead of a
// 404/401. Same mount-order hazard as everything else on this app's root
// still applies — a bridged request carries no session cookie either, so it
// must precede every requireAuth-scoped router below, or requireAuth
// intercepts it and rejects with "Not authenticated." before the bridge
// ever runs. Remove both mounts (and the file) once nothing hits them
// anymore — see server/routes/mcp-bridge.js.
app.use('/api', apiBridgeRouter);
// Public, GitHub-signature-authenticated (no session cookie, no bearer
// token) — same mount-order hazard as apiBridgeRouter above: must precede
// every blanket-requireAuth router below, or requireAuth 401s the webhook
// before this router's own route is ever checked.
app.use('/api', webhooksRouter);
// Public, per-site-bearer-token-authenticated (Universal Product Growth
// mode's CRM boundary) — same mount-order hazard as webhooksRouter above.
app.use('/api', crmWebhookRouter);
// Same token/boundary shape, for "see it live" trial-signup reporting.
app.use('/api', trialSignupRouter);
app.use(rootBridgeRouter);
// Reverse-proxies data-analyst-agent/ under this app's own domain — /data-agent
// is a root path, not under /api (see routes/data-agent.js), and must be
// mounted before the production static/catch-all block below or that
// catch-all's `app.get('*', ...)` would swallow every /data-agent/* request
// first and serve index.html instead of proxying it.
app.use(dataAgentRouter);
app.use('/api', metricsRouter);
app.use('/api', demandRouter);
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
app.use('/api', assistantRouter);
app.use('/api', integrationsRouter);
app.use('/api', notificationsRouter);
app.use('/api', watchlistRouter);
app.use('/api', clientsRouter);
app.use('/api', dataAnalystRouter);
app.use('/api', keywordsRouter);
app.use('/api', commoncrawlBacklinksRouter);
app.use('/api', mcpAdminRouter);
app.use('/api', systemHealthRouter);
app.use('/api', auditLogRouter);
app.use('/api', opsCenterRouter);

// Safety net: a request under /api that no router above matched should
// 404 immediately, not fall through into the SPA catch-all (which would
// serve index.html for an API path) or, worse, into Vite's dev middleware
// below — see vite.config.js's VITE_EMBEDDED note for the self-proxy hang
// that fell through to previously with no /api-scoped catch-all here.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

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
  // See vite.config.js: this marks the embedded (middleware-mode) case so
  // that config skips its "/api" proxy rule, which only makes sense for the
  // standalone `vite` dev server on :5173 — this process already IS the
  // Express server /api requests need to reach.
  process.env.VITE_EMBEDDED = 'true';
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

// Default-safe: only a deliberately-thrown UserFacingError (see
// server/lib/errors.js) reaches the client with its own message. Every
// other error — a raw exception from Postgres, an external API client, or
// anywhere else uncaught — is logged in full here and replaced with a
// generic message plus a correlation id, so a developer can find the real
// error in the logs without a customer (or an admin route's response body)
// ever seeing infrastructure detail. This is the last line of defense; most
// call sites should already be using UserFacingError/safeMessage before an
// error gets this far.
app.use((err, req, res, _next) => {
  if (err.userFacing) {
    res.status(err.status || 400).json({ error: err.message });
    return;
  }
  const id = logInternal(`api:${req.method} ${req.path}`, err);
  res.status(err.status || 500).json({ error: 'Something went wrong on our end. Our team has been notified.', errorId: id });
});

httpServer.listen(port, () => {
  console.log(`[server] listening on :${port}`);
  if (process.env.DISABLE_CRON !== 'true') startCron();
  // Catch up on anything missed while the machine was off/asleep (non-blocking).
  runStartupCatchup();
  // Independent of the DISABLE_CATCHUP-gated call above (staging sets that
  // flag permanently) — re-evaluates blocked_reason on every restart so a
  // config fix that just deployed clears the same moment it goes live
  // instead of waiting for tomorrow's cron. See job.js's own comment.
  reconcileBlockedRecommendationsOnStartup();
  // Reap any audit_runs left stuck 'running' by a previous process that
  // died/restarted mid-audit (non-blocking). An onboarding-triggered audit
  // reaped this way gets auto-retried (capped) so a deploy landing mid-crawl
  // doesn't strand a new client's Milestones baseline on "audit not
  // available" forever — see baseline-report.js's onboarding top-up.
  const MAX_ONBOARDING_AUDIT_ATTEMPTS = 3;
  reapStaleAuditRuns()
    .then(async (reaped) => {
      if (reaped.length) console.log(`[server] reaped ${reaped.length} stale audit run(s)`);
      for (const run of reaped) {
        if (run.triggered_by !== 'onboarding') continue;
        const attempts = await countAuditRunsByTrigger(run.site_id, 'onboarding');
        if (attempts >= MAX_ONBOARDING_AUDIT_ATTEMPTS) {
          console.warn(`[server] site ${run.site_id} onboarding audit has failed ${attempts} times — not auto-retrying further`);
          continue;
        }
        console.log(`[server] retrying reaped onboarding audit for site ${run.site_id} (attempt ${attempts + 1})`);
        startFullSiteAudit(run.site_id, { triggeredBy: 'onboarding' })
          .catch((err) => console.error(`[server] retry of onboarding audit for site ${run.site_id} failed to start:`, err.message));
      }
    })
    .catch((err) => console.error('[server] reapStaleAuditRuns failed:', err.message));
});
