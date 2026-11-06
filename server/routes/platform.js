import { Router } from 'express';
import { requireAuth } from './login.js';
import { getUserById } from '../store/users.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';
import { callDataAnalystAgent } from '../lib/data-analyst-client.js';
import { impactByGeneratorAllSites } from '../store/analyst-outlook.js';
import { fixLabel } from '../agents/lib/analyst-outlook.js';
import { loadInstanceList, loadInstanceDetail } from '../lib/instance-view.js';
import { health as masterHealth, shadowReport } from '../lib/master-agent.js';
import { loadMasterControl, setMasterMode, shadowPlanDetail, MasterControlError } from '../lib/master-agent-control.js';
import { setAutonomy, loadAutonomy, AutonomyError } from '../lib/autonomy-control.js';
import { isPlatformAdmin, listAllWorkspacesForPlatform, getProject, deleteWorkspaceAsPlatform } from '../store/workspaces.js';

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

// Agent instances: each project's Growth Agent seen as one thing, READ ONLY (lib/instance-view.js). Counts, dates and states only;
// no page, query, draft or memory text is ever returned. Nothing here writes, and nothing here is reachable by a non-admin.
router.get('/platform/instances', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try { res.json(await loadInstanceList()); } catch (e) { next(e); }
});

router.get('/platform/instances/:siteId', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const siteId = Number(req.params.siteId);
    if (!Number.isInteger(siteId) || siteId <= 0) return res.status(404).json({ error: 'Not found.' });
    const detail = await loadInstanceDetail(siteId);
    if (!detail) return res.status(404).json({ error: 'Not found.' });
    res.json(detail);
  } catch (e) { next(e); }
});

// The Master Agent: its mode (off / shadow / on), whether it may be switched, what today's queue did, and, while it is planning, how its
// plan compares with what the existing loop did. The mode is chosen here (PUT below), not by editing server settings; the MASTER_AGENT_MODE
// environment variable is only a ceiling on that choice. Job errors are cut to 160 characters and carry project ids, never project content.
async function masterAgentPayload() {
  const control = await loadMasterControl({});
  const h = await masterHealth({ mode: control.mode });
  const shadow = control.mode === 'off' ? null : { ...(await shadowReport()), ...(await shadowPlanDetail()) };
  return { ...h, ...control, shadow };
}

router.get('/platform/master-agent', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try { res.json(await masterAgentPayload()); } catch (e) { next(e); }
});

// Switch the Master Agent. 400 BAD_MODE, 409 CEILING (the server setting forbids it), 409 NOT_READY (On needs 3 clean Shadow days).
router.put('/platform/master-agent/mode', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const user = await getUserById(req.userId);
    let out;
    try { out = await setMasterMode(req.body?.mode, { by: user?.id ?? null, email: user?.email ?? null }); }
    catch (e) { if (e instanceof MasterControlError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
    if (out.changed) {
      await recordAuditEvent(req, {
        action: 'platform.master_agent_mode_changed', targetType: 'platform', targetId: 'master_agent',
        metadata: { from: out.from, to: out.to }, success: true,
      });
    }
    res.json(await masterAgentPayload());
  } catch (e) { next(e); }
});

// A project's auto-fixes switch, from the Agent instances page. It writes the same column and obeys the same rule as the staff Controls
// dialog (lib/autonomy-control.js); turning it on needs a connected GitHub repository (400 NEEDS_GITHUB). The agent never merges.
router.put('/platform/projects/:siteId/autonomy', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const siteId = Number(req.params.siteId);
    if (!Number.isInteger(siteId) || siteId <= 0) return res.status(404).json({ error: 'Not found.' });
    const user = await getUserById(req.userId);
    let out;
    try { out = await setAutonomy(siteId, req.body?.enabled, { by: user?.id ?? null, email: user?.email ?? null }); }
    catch (e) { if (e instanceof AutonomyError) return res.status(e.status).json({ error: e.message, code: e.code }); throw e; }
    if (out.changed) {
      await recordAuditEvent(req, {
        action: out.to ? 'tenant.auto_remediation_enabled' : 'tenant.auto_remediation_disabled',
        targetType: 'site', targetId: String(siteId), tenantSiteId: siteId, tenantName: out.site.name,
        metadata: { enabled: out.to, dailyLimit: out.dailyLimit, repo: `${out.site.repo_owner}/${out.site.repo_name}`, via: 'platform-instances' },
        success: true,
      });
    }
    res.json(await loadAutonomy(siteId, { site: out.site }));
  } catch (e) { next(e); }
});

// Remove a workspace and its projects. The admin must type the workspace's name back, the same re-typing the project
// delete asks for, so one wrong click cannot do it.
router.delete('/platform/workspaces/:id', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Not found.' });
    const { rows } = await (await import('../db.js')).query('SELECT name FROM workspaces WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found.' });
    if (String(req.body?.confirmName || '').trim() !== rows[0].name) return res.status(400).json({ error: 'Type the workspace name exactly to delete it.' });
    const out = await deleteWorkspaceAsPlatform(id, { adminUserId: req.userId, companySiteId: companySiteId(), allowOwn: true });
    if (!out.ok) {
      const msg = { company: 'This workspace holds the SuperRank company site and cannot be deleted.', own: 'You belong to this workspace, so you cannot delete it from here.', not_found: 'Not found.' }[out.code];
      return res.status(out.code === 'not_found' ? 404 : 409).json({ error: msg });
    }
    await recordAuditEvent(req, {
      action: 'platform.workspace_deleted', targetType: 'workspace', targetId: String(id), success: true,
      metadata: { workspaceId: id, name: out.name, projects: out.projects },
    });
    res.json({ ok: true, name: out.name, projects: out.projects });
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


// What the shared prediction model has learned. Numbers only, across every project: which model wins,
// how much data it trained on, and how each kind of fix measured out. No project, page or query appears.
router.get('/platform/analyst-learning', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const [learning, fixes] = await Promise.all([
      callDataAnalystAgent('/admin/learning').catch(() => null),
      impactByGeneratorAllSites().catch(() => []),
    ]);
    res.json({
      projects: learning?.projects ?? 0,
      models: (learning?.models || []).map(({ name, missPct, usedWhereWins, status, note }) => ({ name, missPct, usedWhereWins, status, note })),
      samples: learning?.samples ?? 0,
      needsRows: learning?.needsRows ?? null,
      trainedAt: learning?.trainedAt ?? null,
      forecastMissPct: learning?.forecastMissPct ?? null,
      fixesThatWorked: fixes.map((f) => ({
        label: fixLabel(f.generatorId),
        result: `${f.pctPositive}% gained clicks, ${f.avgClicksDelta > 0 ? '+' : ''}${f.avgClicksDelta} on average`,
        times: f.times,
      })),
    });
  } catch (e) { next(e); }
});

export default router;
