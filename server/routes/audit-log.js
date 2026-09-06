import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { listAuditLog } from '../store/admin/audit-log.js';

// Read-only view over the audit trail every mutating platform/tenant/MCP
// action writes to (server/store/admin/audit-log.js's recordAuditEvent,
// wired in since Phase 2). Its own file, not folded into clients.js or
// mcp-admin.js — audit_log has no natural "owning" router, it's a
// cross-cutting record of everything else.
const router = Router();
router.use(requireAuth, requirePlatformRole('platform_admin'));

router.get('/internal/audit-log', async (req, res, next) => {
  try {
    const { tenantSiteId, actorType, action, since, until, limit, offset } = req.query;
    const rows = await listAuditLog({
      tenantSiteId: tenantSiteId ? Number(tenantSiteId) : undefined,
      actorType: actorType || undefined,
      action: action || undefined,
      since: since || undefined,
      until: until || undefined,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(rows);
  } catch (e) { next(e); }
});

export default router;
