import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { query } from '../db.js';
import { listIntegrationMeta } from '../integrations/registry.js';
import { getIntegrationHealth, listSites } from '../store/read.js';
import { getRecentAgentRunFailureCounts } from '../store/admin/system-health.js';

// Platform Ops / System Health (PLATFORM-ADMIN-DESIGN.md §F.8, §G.2, §K
// Phase 6) — existing-data rollups only, no new instrumentation and no new
// dependency (no Sentry, no Pino), per the design's explicit scope boundary.
const router = Router();
router.use(requireAuth, requirePlatformRole('platform_admin'));

function cronState() {
  return {
    timezone: process.env.TZ || 'Asia/Kolkata',
    daily: process.env.CRON_SCHEDULE || '0 7 * * *',
    weekly: process.env.WEEKLY_CRON_SCHEDULE || '0 8 * * 4',
    hourlyCatchupGuard: '5 * * * *',
    fixVerification: '10 * * * *',
  };
}

router.get('/internal/system-health', async (req, res, next) => {
  let dbConnected = true;
  try {
    await query('SELECT 1');
  } catch {
    dbConnected = false;
  }

  if (!dbConnected) {
    return res.json({ db: { connected: false }, integrations: [], tenantsByStatus: {}, agentRunFailures24h: [], cron: cronState() });
  }

  try {
    // Integrations are shared across all sites today, not per-tenant
    // (integrations.js's own comment on its /check route) — passing null
    // still matches getIntegrationHealth's `WHERE site_id = $1 OR site_id
    // IS NULL`, so this reads the same global rows the tenant-facing view
    // does, just without needing any particular site's id.
    const [meta, healthRows, sites, failures] = await Promise.all([
      listIntegrationMeta(),
      getIntegrationHealth(null),
      listSites(),
      getRecentAgentRunFailureCounts(24),
    ]);

    const healthById = new Map(healthRows.map((r) => [r.integration_id, r]));
    const integrations = meta.map((m) => {
      const row = healthById.get(m.id);
      return {
        id: m.id,
        name: m.name,
        status: row?.status || 'unknown',
        lastCheckedAt: row?.last_checked_at || null,
        errorMessage: row?.error_message || null,
      };
    });

    const tenantsByStatus = sites.reduce((acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1;
      return acc;
    }, {});

    res.json({
      db: { connected: true },
      integrations,
      tenantsByStatus,
      agentRunFailures24h: failures,
      cron: cronState(),
    });
  } catch (e) { next(e); }
});

export default router;
