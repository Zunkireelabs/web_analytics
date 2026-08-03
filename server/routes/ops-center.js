import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { query } from '../db.js';
import { listIntegrationMeta } from '../integrations/registry.js';
import { getIntegrationHealth } from '../store/read.js';
import { listAgentMeta } from '../agents/registry.js';
import { pickProvider, MODEL_DEFAULTS } from '../llm.js';
import {
  getPlatformAgentLatestRuns, getPlatformExecutionLog, getPlatformTodayCounts,
} from '../store/admin/ops-center.js';

// AI Operations Center — platform-wide (cross-tenant), technical operational
// view for staff, distinct from the client-facing AI Growth Command Center
// (/ai-growth, server/routes/command-center.js, one site at a time) and
// complementary to System Health (server/routes/system-health.js, which
// this deliberately does not modify or duplicate imports from — same
// "existing-data rollups only" discipline, just aggregated differently: by
// agent/execution instead of by integration/tenant-count).
const router = Router();
router.use(requireAuth, requirePlatformRole('platform_admin'));

const DATA_ANALYST_AGENT_URL = process.env.DATA_ANALYST_AGENT_INTERNAL_URL || 'http://127.0.0.1:8000';
const DATA_ANALYST_AGENT_ADMIN_KEY = process.env.DATA_ANALYST_AGENT_ADMIN_KEY || '';

// Best-effort reachability ping for the Forecast Engine (data-analyst-agent).
// Never throws — an unreachable service is a real, displayable status
// ("down"), not a request failure for this whole dashboard.
async function checkForecastEngine() {
  try {
    const res = await fetch(new URL('/health', DATA_ANALYST_AGENT_URL), {
      headers: { 'X-Admin-Key': DATA_ANALYST_AGENT_ADMIN_KEY },
      signal: AbortSignal.timeout(3000),
    });
    return { id: 'forecast-engine', name: 'Forecast Engine (data-analyst-agent)', status: res.ok ? 'ok' : 'error', errorMessage: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { id: 'forecast-engine', name: 'Forecast Engine (data-analyst-agent)', status: 'error', errorMessage: e.message || 'unreachable' };
  }
}

function cronState() {
  return {
    timezone: process.env.TZ || 'Asia/Kolkata',
    daily: process.env.CRON_SCHEDULE || '0 7 * * *',
    weekly: process.env.WEEKLY_CRON_SCHEDULE || '0 8 * * 4',
    hourlyCatchupGuard: '5 * * * *',
    fixVerification: '10 * * * *',
  };
}

router.get('/internal/ops-center', async (req, res, next) => {
  try {
    const meta = await listAgentMeta();
    const agentIds = meta.map((m) => m.id);

    const [
      latestRuns, executionLog, todayCounts, integrationMeta, integrationHealthRows, forecastEngine, ingestionRow,
    ] = await Promise.all([
      getPlatformAgentLatestRuns(agentIds),
      getPlatformExecutionLog(30),
      getPlatformTodayCounts(),
      listIntegrationMeta(),
      getIntegrationHealth(null),
      checkForecastEngine(),
      // "Ingestion delayed" reuses the same daily-pipeline outcome System
      // Health's daily-pipeline integration re-reads — see
      // server/integrations/daily-pipeline.js's own comment on why this is
      // a re-read of the job's last self-recorded outcome, not a live probe.
      query(`SELECT status FROM integration_health WHERE integration_id = 'daily-pipeline' AND site_id IS NULL`),
    ]);

    const runsByAgent = new Map(latestRuns.map((r) => [r.agent_id, r]));
    const agentTaskforce = meta.map((m) => {
      const run = runsByAgent.get(m.id);
      return {
        id: m.id,
        name: m.name || m.id,
        category: m.category || 'general',
        description: m.description || null,
        lastRunStatus: run?.status || null, // 'ok' | 'error' | 'insufficient-data' | null (never run)
        lastRunAt: run?.created_at || null,
        tookMs: run?.took_ms ?? null,
      };
    });

    const healthById = new Map(integrationHealthRows.map((r) => [r.integration_id, r]));
    const pipelineHealth = [
      ...integrationMeta.map((m) => {
        const row = healthById.get(m.id);
        return {
          id: m.id, name: m.name,
          status: row?.status || 'unknown',
          lastCheckedAt: row?.last_checked_at || null,
          errorMessage: row?.error_message || null,
        };
      }),
      forecastEngine,
    ];

    const provider = pickProvider();
    const modelStatus = {
      provider,
      dailyModel: MODEL_DEFAULTS[provider]?.daily || 'unknown',
      monthlyModel: MODEL_DEFAULTS[provider]?.monthly || 'unknown',
      // Hardcoded reference to the Python service's own sole model constant
      // (data-analyst-agent/app/agent/narrator.py) — not a live call, since
      // that value never changes without a code deploy on that side either.
      forecastModel: 'gpt-4o-mini',
    };

    res.json({
      technicalSummary: {
        ...todayCounts,
        ingestionDelayed: ingestionRow.rows[0] ? ingestionRow.rows[0].status !== 'ok' : null,
        forecastEngineReachable: forecastEngine.status === 'ok',
      },
      agentTaskforce,
      executionLog: executionLog.map((r) => ({
        siteId: r.site_id, siteName: r.site_name, agentId: r.agent_id,
        status: r.status, tookMs: r.took_ms, createdAt: r.created_at,
      })),
      pipelineHealth,
      modelStatus,
      cron: cronState(),
    });
  } catch (e) { next(e); }
});

export default router;
