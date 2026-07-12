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
import { startCron } from './cron.js';
import { runStartupCatchup } from './job.js';
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
app.use('/api', loginRouter);
app.use('/api', metricsRouter);
app.use('/api', agentsRouter);
app.use('/api', actionCenterRouter);
app.use('/api', reportsRouter);

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
});
