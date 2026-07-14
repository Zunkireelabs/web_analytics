import { Router } from 'express';
import { requireAuth, requireInternalSite } from './login.js';
import { listIntegrationMeta, getIntegration } from '../integrations/registry.js';
import { getIntegrationHealth } from '../store/read.js';
import { recordIntegrationCheck } from '../store/upsert.js';

// Internal-only — the fix action for a broken integration (re-running an
// OAuth consent flow, rotating an API key) is developer/admin-only, so full
// diagnostic detail isn't actionable for regular client logins.
const router = Router();
router.use(requireAuth, requireInternalSite);

// Joins registry meta with the latest persisted status for this site —
// an integration never checked yet defaults to status: 'unknown', not an
// error, since no row exists for it in integration_health.
router.get('/integrations/health', async (req, res, next) => {
  try {
    const [meta, rows] = await Promise.all([
      listIntegrationMeta(),
      getIntegrationHealth(req.siteId),
    ]);
    const byId = new Map(rows.map((r) => [r.integration_id, r]));
    res.json(meta.map((m) => {
      const row = byId.get(m.id);
      return {
        ...m,
        status: row?.status || 'unknown',
        authStatus: row?.auth_status || null,
        lastSuccessAt: row?.last_success_at || null,
        lastFailureAt: row?.last_failure_at || null,
        lastCheckedAt: row?.last_checked_at || null,
        errorMessage: row?.error_message || null,
        recoveryAction: row?.recovery_action || null,
      };
    }));
  } catch (e) { next(e); }
});

// On-demand live check — runs the integration's real check() now and
// records it immediately, so a fix can be verified without waiting for the
// next cron cycle. site_id is recorded as null (every integration today is
// shared across all sites, not per-site) regardless of which admin triggered it.
router.post('/integrations/:id/check', async (req, res, next) => {
  try {
    const integration = await getIntegration(req.params.id);
    if (!integration) return res.status(404).json({ error: `Unknown integration "${req.params.id}"` });

    const result = await integration.check({ id: req.siteId });
    await recordIntegrationCheck(integration.meta.id, null, result);
    res.json({ id: integration.meta.id, ...result });
  } catch (e) { next(e); }
});

export default router;
