import { Router } from 'express';
import { requireAuth } from './login.js';
import { startFullSiteAudit } from '../agents/lib/bulk-audit.js';
import { getAuditRun, listAuditRuns, getAuditPageFindings } from '../store/audit-runs.js';

// Full Site Audit — manual trigger + history/report view (Website
// Intelligence plan, Phase 6). Internal-only, same gate as Action Center/
// Command Center: this is a company-only capability, not part of the
// client-facing product.
const router = Router();
router.use(requireAuth);

// Kicks off a Full Site Audit in the background and returns immediately with
// the new audit_runs id — a full audit can take from seconds to over an
// hour depending on site size, far longer than an HTTP request should block
// for. The frontend polls GET /site-audit/runs/:id for completion.
router.post('/site-audit/run', async (req, res, next) => {
  try {
    const { maxPages } = req.body || {};
    const auditRunId = await startFullSiteAudit(req.siteId, {
      triggeredBy: 'manual',
      ...(maxPages ? { maxPages: Number(maxPages) } : {}),
    });
    res.json({ auditRunId, status: 'running' });
  } catch (e) { next(e); }
});

router.get('/site-audit/runs', async (req, res, next) => {
  try {
    res.json(await listAuditRuns(req.siteId));
  } catch (e) { next(e); }
});

// Findings are fetched regardless of status — checkpointed writes mean a
// still-running audit already has real partial findings worth showing, not
// just a spinner until the whole thing finishes.
router.get('/site-audit/runs/:id', async (req, res, next) => {
  try {
    const run = await getAuditRun(Number(req.params.id));
    if (!run || run.site_id !== req.siteId) return res.status(404).json({ error: 'not found' });
    const findings = await getAuditPageFindings(run.id);
    res.json({ ...run, findings });
  } catch (e) { next(e); }
});

export default router;
