import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { getUserById } from '../store/users.js';
import { getSiteById } from '../store/read.js';
import { createInsightReportDoc } from '../report/insight-doc.js';
import { generateDraft } from './action-center.js';
import { seoDraftEligibility } from '../agents/lib/analyst-seo-mapping.js';

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

router.get('/internal/analyst/clients/:clientId/metrics/:metricKey/dimensions', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/metrics/${req.params.metricKey}/dimensions`));
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

router.post('/internal/analyst/clients/:clientId/recommendations/:recommendationId/dismiss', async (req, res, next) => {
  try {
    const actor = await getUserById(req.userId);
    res.json(await callPython(
      `/clients/${req.params.clientId}/recommendations/${req.params.recommendationId}/dismiss`,
      { method: 'POST', body: { dismissed_by: actor?.email || null } },
    ));
  } catch (e) { next(e); }
});

// "Create Executive Summary" — on-demand, stateless (regenerated per call
// on the Python side, same as /ask), so this is just a thin proxy like
// resolve/dismiss above, no actor to inject.
router.post('/internal/analyst/clients/:clientId/recommendations/:recommendationId/summary', async (req, res, next) => {
  try {
    res.json(await callPython(
      `/clients/${req.params.clientId}/recommendations/${req.params.recommendationId}/summary`,
      { method: 'POST', body: {} },
    ));
  } catch (e) { next(e); }
});

// "Generate Investigation Report" — runs entirely in Node, never proxied to
// Python, since Google Docs auth is scoped per-`site` here (see
// auth/google.js) and Client.id == sites.id by convention. Deliberately
// generic: the frontend already renders this finding's diagnosis/root
// cause/evidence/repair-strategy text on screen, so it sends that same
// rendered content as {label, body} sections rather than this route
// re-deriving insight-type-specific formatting a second time in a second
// language.
router.post('/internal/analyst/clients/:clientId/insights/investigation-report', async (req, res, next) => {
  try {
    const site = await getSiteById(req.params.clientId);
    if (!site) { const err = new Error('Client not found.'); err.status = 404; throw err; }
    const { title, sections } = req.body || {};
    if (!title || !Array.isArray(sections) || sections.length === 0) {
      const err = new Error('title and a non-empty sections array are required.');
      err.status = 400;
      throw err;
    }
    const { url } = await createInsightReportDoc(site, { title, sections });
    res.json({ url });
  } catch (e) { next(e); }
});

// "Generate Content Draft" (SEO draft-wiring) — re-validates eligibility
// server-side (never trusts the frontend's disabled state alone) before
// calling the existing, unmodified generateDraft() from action-center.js.
// Only ever eligible for a gsc_* insight with dimension_type === 'page'
// representing a decline — see analyst-seo-mapping.js. Until the
// data-analyst-agent page-dimension collector has admitted at least one
// page for a client, no insight will ever satisfy this, and the route
// 400s accordingly; the frontend keeps the button disabled in that case
// rather than surfacing a raw error.
router.post('/internal/analyst/clients/:clientId/insights/generate-draft', async (req, res, next) => {
  try {
    const site = await getSiteById(req.params.clientId);
    if (!site) { const err = new Error('Client not found.'); err.status = 404; throw err; }
    const { insight } = req.body || {};
    const action = seoDraftEligibility(site, insight);
    if (!action) {
      const err = new Error('This finding is not eligible for draft generation.');
      err.status = 400;
      throw err;
    }
    const draft = await generateDraft(site.id, {
      generatorId: action.generatorId, params: action.params,
      source: 'analyst', findingId: action.findingId,
    });
    res.json(draft);
  } catch (e) { next(e); }
});

// Cross-client — no clientId in the path, matches the Python route.
router.get('/internal/analyst/alerts', async (req, res, next) => {
  try {
    res.json(await callPython('/alerts'));
  } catch (e) { next(e); }
});

// AI Analyst Workspace — Phase 2 intelligence engines. Same thin-passthrough
// discipline as everything above: no logic here, just X-Admin-Key injection
// and path forwarding.
router.get('/internal/analyst/clients/:clientId/diagnostics/:metricKey', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/diagnostics/${req.params.metricKey}`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/correlations', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/correlations`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/root-cause/:insightId', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/root-cause/${req.params.insightId}`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/effort-estimation/:recommendationId', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/effort-estimation/${req.params.recommendationId}`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/time-to-impact/:recommendationId', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/time-to-impact/${req.params.recommendationId}`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/opportunity-score/:recommendationId', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/opportunity-score/${req.params.recommendationId}`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/recommendation-rankings', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/recommendation-rankings`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/feature-importance/:targetMetricKey', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/feature-importance/${req.params.targetMetricKey}`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/business-values', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/business-values`));
  } catch (e) { next(e); }
});

router.put('/internal/analyst/clients/:clientId/business-values', async (req, res, next) => {
  try {
    const { conversionValue, avgOrderValue, leadValue, revenuePerConversion, currency } = req.body || {};
    res.json(await callPython(`/clients/${req.params.clientId}/business-values`, {
      method: 'PUT',
      body: {
        conversion_value: conversionValue ?? null, avg_order_value: avgOrderValue ?? null,
        lead_value: leadValue ?? null, revenue_per_conversion: revenuePerConversion ?? null,
        currency: currency || 'USD',
      },
    }));
  } catch (e) { next(e); }
});

router.post('/internal/analyst/clients/:clientId/impact-projection', async (req, res, next) => {
  try {
    const { metricKey, dimensionType, dimensionValue, deltaValue, deltaDirection, currentValue, priorValue } = req.body || {};
    res.json(await callPython(`/clients/${req.params.clientId}/impact-projection`, {
      method: 'POST',
      body: {
        metric_key: metricKey, dimension_type: dimensionType, dimension_value: dimensionValue,
        delta_value: deltaValue, delta_direction: deltaDirection,
        current_value: currentValue ?? null, prior_value: priorValue ?? null,
      },
    }));
  } catch (e) { next(e); }
});

router.post('/internal/analyst/dashboard/:clientId/executive-summary', async (req, res, next) => {
  try {
    res.json(await callPython(`/dashboard/${req.params.clientId}/executive-summary`, { method: 'POST', body: {} }));
  } catch (e) { next(e); }
});

// Investigations (Phase 3) — same thin-passthrough discipline as everything
// above. status/severity are optional query-string filters, forwarded as-is.
router.get('/internal/analyst/clients/:clientId/investigations', async (req, res, next) => {
  try {
    const { status, severity } = req.query;
    res.json(await callPython(`/clients/${req.params.clientId}/investigations`, { query: { status, severity } }));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/investigations/:investigationId', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/investigations/${req.params.investigationId}`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/investigations/:investigationId/events', async (req, res, next) => {
  try {
    res.json(await callPython(`/clients/${req.params.clientId}/investigations/${req.params.investigationId}/events`));
  } catch (e) { next(e); }
});

router.get('/internal/analyst/clients/:clientId/opportunities', async (req, res, next) => {
  try {
    const { status } = req.query;
    res.json(await callPython(`/clients/${req.params.clientId}/opportunities`, { query: { status } }));
  } catch (e) { next(e); }
});

// AI Command Center feed (Phase 3) — cross-client, matches the Python route.
router.get('/internal/analyst/activity', async (req, res, next) => {
  try {
    const { limit } = req.query;
    res.json(await callPython('/activity', { query: { limit } }));
  } catch (e) { next(e); }
});

export default router;
