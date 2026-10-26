import { Router } from 'express';
import { requireAuth } from './login.js';
import { getUserById } from '../store/users.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';
import { isPlatformAdmin, listAllWorkspacesForPlatform, getProject } from '../store/workspaces.js';

// The platform admin's own view across every client workspace. Everything here
// is a 404 for anyone else — not a 403 — so the existence of the view is not
// confirmed to an ordinary user.
const router = Router();
const companySiteId = () => Number(process.env.COMPANY_SITE_ID);

async function requirePlatformAdmin(req, res, next) {
  try {
    const user = await getUserById(req.userId);
    if (!isPlatformAdmin(user, companySiteId())) return res.status(404).json({ error: 'Not found.' });
    next();
  } catch (e) { next(e); }
}

router.get('/platform/workspaces', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const workspaces = await listAllWorkspacesForPlatform();
    res.json({
      workspaces,
      totals: {
        workspaces: workspaces.length,
        projects: workspaces.reduce((n, w) => n + w.projects.length, 0),
        needsSetup: workspaces.reduce((n, w) => n + w.needsSetup, 0),
      },
    });
  } catch (e) { next(e); }
});

// Opening a client's project as support is logged, so a client can always be
// told who from SuperRank looked at their project and when. The switch itself is
// the ordinary /session/site call the platform admin already has; this only
// records it, before the page navigates.
router.post('/platform/support-view', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const siteId = Number(req.body?.siteId);
    const project = Number.isInteger(siteId) && siteId > 0 ? await getProject(siteId) : null;
    if (!project) return res.status(404).json({ error: 'Not found.' });
    await recordAuditEvent(req, {
      action: 'platform.support_view', targetType: 'site', targetId: String(siteId), tenantSiteId: siteId, tenantName: project.name,
      metadata: { workspaceId: project.workspace_id }, success: true,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
