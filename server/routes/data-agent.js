import { Router } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { requireAuth, requirePlatformRole } from './login.js';

// Reverse-proxies the standalone data-analyst-agent/ Python service under
// this app's own domain (analytics.zunkireelabs.com/data-agent/...) instead
// of giving it a separate subdomain — avoids new DNS/Traefik config. Both
// containers share the "hosting" Docker network in prod, so
// DATA_ANALYST_AGENT_INTERNAL_URL resolves by container name there; locally
// it points at the service's own uvicorn process. Gated the same way
// server/routes/system-health.js is. Raw passthrough (including Swagger UI,
// X-Admin-Key entered manually there) for debugging/exploring the API
// directly — the real staff-facing surface is /analyst
// (server/routes/dataAnalyst.js), which injects the admin key server-side.
const router = Router();

router.use(
  '/data-agent',
  requireAuth,
  requirePlatformRole('platform_admin'),
  createProxyMiddleware({
    target: process.env.DATA_ANALYST_AGENT_INTERNAL_URL || 'http://127.0.0.1:8000',
    changeOrigin: true,
  })
);

export default router;
