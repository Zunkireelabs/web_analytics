import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import express from 'express';
import session from 'express-session';
import loginRouter from './routes/login.js';
import metricsRouter from './routes/metrics.js';
import { startCron } from './cron.js';
import { runStartupCatchup } from './job.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.set('trust proxy', 1); // behind Traefik
app.use(
  session({
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

// In production, serve the built dashboard (web/dist) from the same server.
const dist = join(here, '..', 'web', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => res.sendFile(join(dist, 'index.html')));
}

app.use((err, req, res, _next) => {
  console.error('[api] error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = Number(process.env.API_PORT || 3002);
app.listen(port, () => {
  console.log(`[server] listening on :${port}`);
  if (process.env.DISABLE_CRON !== 'true') startCron();
  // Catch up on anything missed while the machine was off/asleep (non-blocking).
  runStartupCatchup();
});
