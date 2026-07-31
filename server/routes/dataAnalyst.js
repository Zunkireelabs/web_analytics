import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { getUserById } from '../store/users.js';

// Narrow, JSON-shaped proxy to the standalone data-analyst-agent/ Python
// service, for the in-app /analyst page (web/src/pages/Analyst.jsx) — a
// deliberately separate concern from server/routes/data-agent.js, which
// raw-proxies the *entire* service (including its Swagger UI) with no
// credential injection, requiring staff to paste the admin key into the
// "Try it out" panel themselves. Every route here instead attaches
// X-Admin-Key server-side from DATA_ANALYST_AGENT_ADMIN_KEY, so the browser
// never sees that service-wide secret. Staff-only, same gate as
// server/routes/clients.js (this page is cross-client, like /clients).
const router = Router();
router.use(requireAuth, requirePlatformRole('platform_admin'));

const PYTHON_BASE_URL = process.env.DATA_ANALYST_AGENT_INTERNAL_URL || 'http://127.0.0.1:8000';

async function callPython(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path, PYTHON_BASE_URL);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Admin-Key': process.env.DATA_ANALYST_AGENT_ADMIN_KEY || '',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error(`Data Analyst Agent unreachable: ${e.message}`);
    err.status = 502;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || `Data Analyst Agent returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Each handler just forwards client_id (already an integer path param —
// Client.id is deliberately the same id as this app's sites.id, see
// data-analyst-agent/app/db/models.py) and re-throws through Express's
// error middleware (server/index.js) rather than catching locally.

router.get('/internal/analyst/dashboard/:clientId', async (req, res, next) => {
  try {
    res.json(await callPython(`/dashboard/${req.params.clientId}`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/dashboard/:clientId/series/:metricKey', async (req, res, next) => {
  try {
    res.json(await callPython(`/dashboard/${req.params.clientId}/series/${req.params.metricKey}`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/dashboard/:clientId/breakdown/:metricKey/:dimensionType', async (req, res, next) => {
  try {
    res.json(await callPython(`/dashboard/${req.params.clientId}/breakdown/${req.params.metricKey}/${req.params.dimensionType}`));
  } catch (e) { next(e); }
});

router.post('/internal/analyst/ask/:clientId', async (req, res, next) => {
  try {
    res.json(await callPython(`/ask/${req.params.clientId}`, { method: 'POST', body: { question: req.body.question } }));
  } catch (e) { next(e); }
});

router.post('/internal/analyst/clients/:clientId/recommendations/:recommendationId/resolve', async (req, res, next) => {
  try {
    const actor = await getUserById(req.userId);
    res.json(await callPython(
      `/clients/${req.params.clientId}/recommendations/${req.params.recommendationId}/resolve`,
      { method: 'POST', body: { resolved_by: actor?.email || null } },
    ));
  } catch (e) { next(e); }
});

// Cross-client — no clientId in the path, matches the Python route.
router.get('/internal/analyst/alerts', async (req, res, next) => {
  try {
    res.json(await callPython('/alerts'));
  } catch (e) { next(e); }
});

export default router;
