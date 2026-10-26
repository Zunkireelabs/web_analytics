import { Router } from 'express';
import { requireAuth } from './login.js';
import { getUserById, getUserByEmail } from '../store/users.js';
import { createInvitation } from '../store/user-invitations.js';
import { sendInvitationEmail } from '../report/email.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';
import { createApiToken, listApiTokensForWorkspace, revokeApiTokenInWorkspace } from '../store/api-tokens.js';
import { gscDailyDataAsOf } from '../store/data-freshness.js';
import { getRecentAgentRunFailureCounts } from '../store/admin/system-health.js';
import { PERMISSION_LEVELS, DEFAULT_PERMISSION_LEVEL } from '../../mcp-server/permissions.js';
import { HttpError, grantProjectAccess } from './lib/project-access.js';
import {
  WORKSPACE_ROLE_RANK, tenantRoleForWorkspaceRole, effectiveWorkspaceRole, roleAtLeast, decideMemberChange, isPlatformAdmin,
  getWorkspaceById, getMembershipRole, countOwners, listMembers, listPendingInvitations,
  addMember, updateMemberRole, removeMember, inviteHomeSiteId, createProject,
  createWorkspace, renameWorkspace, siteInWorkspace, validateGoal, setProjectGoal, listGoalsForSites, claimHomeSiteIfNone,
  summarizeProjectHealth, listWorkspaceSites, listWorkspaceActivity, describeActivity, listProjectMembersForWorkspace,
} from '../store/workspaces.js';

// Workspace management: projects, members, invitations, goals, tokens and
// health. Every route is session-authenticated and then gated by the caller's
// role IN THAT WORKSPACE (member < admin < owner). A caller with no role in the
// workspace gets a 404, not a 403, so a workspace id they do not belong to is
// never confirmed to exist. The workspace is read from the URL, but nothing
// else is trusted from the client: the role comes from workspace_members,
// never the request, and every siteId in a URL is re-checked to be a project of
// that same workspace.
const router = Router();

const companySiteId = () => Number(process.env.COMPANY_SITE_ID);

function requireWorkspaceRole(minRole) {
  if (!WORKSPACE_ROLE_RANK[minRole]) throw new Error(`requireWorkspaceRole: unknown role "${minRole}"`);
  return async function (req, res, next) {
    try {
      const workspaceId = Number(req.params.id);
      if (!Number.isInteger(workspaceId) || workspaceId <= 0) return res.status(404).json({ error: 'Not found.' });
      const [user, membershipRole] = await Promise.all([
        getUserById(req.userId),
        getMembershipRole(req.userId, workspaceId),
      ]);
      const role = effectiveWorkspaceRole({ user, membershipRole, companySiteId: companySiteId() });
      if (!role) return res.status(404).json({ error: 'Not found.' });
      if (!roleAtLeast(role, minRole)) return res.status(403).json({ error: 'You need to be a workspace admin to do that.' });
      req.workspaceId = workspaceId;
      req.workspaceRole = role;
      next();
    } catch (e) { next(e); }
  };
}

const originOf = (req) => `${req.protocol}://${req.get('host')}`;
const cleanDomain = (d) => (d ? String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null);

// Give one person access to a workspace. A person with an account is added
// straight away; anyone else is emailed an invitation (which needs a project to
// hang their account on). Shared by "invite", "create workspace" and "hand over"
// so the three can never drift apart. Returns what happened; throws HttpError.
async function grantAccess(req, workspace, email, role, projectIds = null) {
  if (projectIds?.length) {
    // Project-level access: never ownership, and every project must be in THIS workspace.
    if (role === 'owner') throw new HttpError(400, 'Ownership can only be given for the whole workspace.');
    const ids = [...new Set(projectIds.map(Number))];
    for (const id of ids) {
      if (!Number.isInteger(id) || !(await siteInWorkspace(id, workspace.id))) throw new HttpError(404, 'One of those projects is not in this workspace.');
    }
    return grantProjectAccess(req, workspace, email, role, ids);
  }
  if (!email || !email.includes('@')) throw new HttpError(400, 'A valid email is required.');
  if (!WORKSPACE_ROLE_RANK[role]) throw new HttpError(400, `role must be one of: ${Object.keys(WORKSPACE_ROLE_RANK).join(', ')}.`);
  if (role === 'owner' && req.workspaceRole !== 'owner') throw new HttpError(403, 'Only an owner can grant ownership.');

  const existing = await getUserByEmail(email);
  if (existing) {
    const added = await addMember(workspace.id, existing.id, role);
    if (!added) throw new HttpError(409, `${email} is already a member of this workspace.`);
    await recordAuditEvent(req, {
      action: 'workspace.member_added', targetType: 'user', targetId: String(existing.id),
      metadata: { workspaceId: workspace.id, email, role }, success: true,
    });
    return { added: true, email, role, userId: existing.id };
  }

  const homeSiteId = await inviteHomeSiteId(workspace.id, req.siteId);
  if (!homeSiteId) throw new HttpError(400, 'Add a project to this workspace before inviting people.');
  const invitation = await createInvitation({
    siteId: homeSiteId, email, role: tenantRoleForWorkspaceRole(role), invitedBy: req.userId,
    workspaceId: workspace.id, workspaceRole: role,
  });
  try {
    await sendInvitationEmail({ to: email, siteName: workspace.name, role, acceptUrl: `${originOf(req)}/accept-invite?token=${invitation.token}` });
  } catch (err) {
    console.error('[workspaces] invitation email failed:', err.message);
  }
  await recordAuditEvent(req, {
    action: 'workspace.member_invited', targetType: 'user_invitation', targetId: String(invitation.id),
    metadata: { workspaceId: workspace.id, email, role }, success: true,
  });
  return { invited: true, id: invitation.id, email, role, expiresAt: invitation.expires_at };
}

const sendError = (res, e, next) => (e instanceof HttpError ? res.status(e.status).json({ error: e.message }) : next(e));

// ───────── create / rename ─────────

// Anyone signed in can create a workspace of their own (no cap, for now) and
// becomes its owner. A platform admin can instead create one for a client by
// naming that client's email as owner. The first project, its goal and the
// first invitations ride along so the guided flow is one request.
router.post('/workspaces', requireAuth, async (req, res, next) => {
  try {
    const { name, projectName, websiteDomain, timezone, goal, invites, ownerEmail } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'name is required.' });
    if (cleanName.length > 120) return res.status(400).json({ error: 'name is too long.' });
    const project = String(projectName || '').trim();
    if (project.length > 120) return res.status(400).json({ error: 'projectName is too long.' });
    const goalCheck = goal ? validateGoal(goal) : null;
    if (goalCheck && !goalCheck.ok) return res.status(400).json({ error: goalCheck.reason });
    if (goal && !project) return res.status(400).json({ error: 'A goal needs a project to belong to.' });
    const people = Array.isArray(invites) ? invites : [];
    if ((people.length || ownerEmail) && !project) return res.status(400).json({ error: 'Add a project before inviting people.' });

    const user = await getUserById(req.userId);
    const platform = isPlatformAdmin(user, companySiteId());
    if (ownerEmail && !platform) return res.status(403).json({ error: 'Only a platform admin can create a workspace for someone else.' });

    const workspace = await createWorkspace({ name: cleanName });
    // The creator owns what they create. A platform admin setting one up for a
    // client keeps their own support access without a membership row.
    if (!ownerEmail) await addMember(workspace.id, req.userId, 'owner');
    req.workspaceId = workspace.id;
    req.workspaceRole = 'owner';
    await recordAuditEvent(req, {
      action: 'workspace.created', targetType: 'workspace', targetId: String(workspace.id),
      metadata: { workspaceId: workspace.id, name: workspace.name }, success: true,
    });

    let site = null;
    if (project) {
      site = await createProject({ workspaceId: workspace.id, name: project, websiteDomain: cleanDomain(websiteDomain), timezone });
      await claimHomeSiteIfNone(req.userId, site.id);
      await recordAuditEvent(req, {
        action: 'project.created', targetType: 'site', targetId: String(site.id), tenantSiteId: site.id, tenantName: site.name,
        metadata: { workspaceId: workspace.id, name: site.name, websiteDomain: site.website_domain }, success: true,
      });
      if (goalCheck) {
        await setProjectGoal({ siteId: site.id, ...goalCheck.goal, userId: req.userId });
        await recordAuditEvent(req, {
          action: 'project.goal_set', targetType: 'site', targetId: String(site.id), tenantSiteId: site.id, tenantName: site.name,
          metadata: { workspaceId: workspace.id, goal: goalCheck.goal.goal }, success: true,
        });
      }
    }

    const results = [];
    const grants = [
      ...(ownerEmail ? [{ email: String(ownerEmail).trim().toLowerCase(), role: 'owner' }] : []),
      ...people.map((p) => ({ email: String(p?.email || '').trim().toLowerCase(), role: p?.role || 'member' })),
    ];
    for (const g of grants) {
      try { results.push(await grantAccess(req, workspace, g.email, g.role)); }
      catch (e) { if (!(e instanceof HttpError)) throw e; results.push({ email: g.email, role: g.role, error: e.message }); }
    }
    res.status(201).json({ workspace, project: site && { id: site.id, name: site.name, domain: site.website_domain }, access: results });
  } catch (e) { next(e); }
});

router.patch('/workspaces/:id', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required.' });
    if (name.length > 120) return res.status(400).json({ error: 'name is too long.' });
    const updated = await renameWorkspace(req.workspaceId, name);
    await recordAuditEvent(req, {
      action: 'workspace.renamed', targetType: 'workspace', targetId: String(req.workspaceId),
      metadata: { workspaceId: req.workspaceId, name }, success: true,
    });
    res.json(updated);
  } catch (e) { next(e); }
});

// ───────── overview: projects, goals, health, activity ─────────

router.get('/workspaces/:id/overview', requireAuth, requireWorkspaceRole('member'), async (req, res, next) => {
  try {
    const [workspace, sites] = await Promise.all([getWorkspaceById(req.workspaceId), listWorkspaceSites(req.workspaceId)]);
    const siteIds = sites.map((s) => s.id);
    const [goals, failures, activity, freshness] = await Promise.all([
      listGoalsForSites(siteIds),
      getRecentAgentRunFailureCounts(24),
      listWorkspaceActivity(req.workspaceId, siteIds),
      Promise.all(sites.map((s) => gscDailyDataAsOf(s.id).catch(() => ({ as_of: null })))),
    ]);
    const failuresBySite = {};
    for (const f of failures) if (siteIds.includes(f.site_id)) failuresBySite[f.site_id] = (failuresBySite[f.site_id] || 0) + f.failure_count;

    const projects = sites.map((s, i) => ({
      id: s.id, name: s.name, domain: s.website_domain, goal: goals[s.id] || null,
      health: summarizeProjectHealth({ site: s, dataAsOf: freshness[i]?.as_of, agentFailures24h: failuresBySite[s.id] || 0 }),
    }));
    res.json({
      workspace, yourRole: req.workspaceRole, projects,
      needsAttention: projects.filter((p) => p.health.status === 'attention').length,
      activity: activity.map(describeActivity).filter(Boolean),
    });
  } catch (e) { next(e); }
});

// ───────── members and projects ─────────

// Members and invitations that are still pending, plus the caller's own role so
// the UI can show or hide management controls (the server enforces them anyway).
router.get('/workspaces/:id/members', requireAuth, requireWorkspaceRole('member'), async (req, res, next) => {
  try {
    const [workspace, members, invitations, projectMembers] = await Promise.all([
      getWorkspaceById(req.workspaceId), listMembers(req.workspaceId), listPendingInvitations(req.workspaceId),
      listProjectMembersForWorkspace(req.workspaceId),
    ]);
    // projectMembers: people whose access is limited to specific projects (one row per person per project).
    res.json({ workspace, yourRole: req.workspaceRole, members, projectMembers, invitations });
  } catch (e) { next(e); }
});

// A new project inside this workspace. The workspace's existing members
// already have access to it, so no new login is created.
router.post('/workspaces/:id/projects', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    const { name, websiteDomain, timezone, goal } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'name is required.' });
    if (cleanName.length > 120) return res.status(400).json({ error: 'name is too long.' });
    const goalCheck = goal ? validateGoal(goal) : null;
    if (goalCheck && !goalCheck.ok) return res.status(400).json({ error: goalCheck.reason });

    const site = await createProject({
      workspaceId: req.workspaceId, name: cleanName, websiteDomain: cleanDomain(websiteDomain), timezone,
    });
    // A new account has no home site yet (migration 198); its first project becomes it.
    await claimHomeSiteIfNone(req.userId, site.id);
    await recordAuditEvent(req, {
      action: 'project.created', targetType: 'site', targetId: String(site.id),
      tenantSiteId: site.id, tenantName: site.name,
      metadata: { workspaceId: req.workspaceId, name: site.name, websiteDomain: site.website_domain }, success: true,
    });
    if (goalCheck) {
      await setProjectGoal({ siteId: site.id, ...goalCheck.goal, userId: req.userId });
      await recordAuditEvent(req, {
        action: 'project.goal_set', targetType: 'site', targetId: String(site.id), tenantSiteId: site.id, tenantName: site.name,
        metadata: { workspaceId: req.workspaceId, goal: goalCheck.goal.goal }, success: true,
      });
    }
    res.status(201).json({ id: site.id, name: site.name, domain: site.website_domain, workspaceId: req.workspaceId });
  } catch (e) { next(e); }
});

// Set or change a project's goal. The project must belong to THIS workspace.
router.put('/workspaces/:id/projects/:siteId/goal', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    const siteId = Number(req.params.siteId);
    if (!Number.isInteger(siteId) || !(await siteInWorkspace(siteId, req.workspaceId))) return res.status(404).json({ error: 'Not found.' });
    const check = validateGoal(req.body);
    if (!check.ok) return res.status(400).json({ error: check.reason });
    const saved = await setProjectGoal({ siteId, ...check.goal, userId: req.userId });
    await recordAuditEvent(req, {
      action: 'project.goal_set', targetType: 'site', targetId: String(siteId), tenantSiteId: siteId,
      metadata: { workspaceId: req.workspaceId, goal: check.goal.goal }, success: true,
    });
    res.json(saved);
  } catch (e) { next(e); }
});

// Invite by email. A person who has no account is emailed a link; a person who
// already has one is added to the workspace straight away (they already
// authenticated with that email, and gain access, never lose it).
router.post('/workspaces/:id/members', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const workspace = await getWorkspaceById(req.workspaceId);
    const result = await grantAccess(req, workspace, email, req.body?.role || 'member', req.body?.projectIds);
    res.status(201).json(result);
  } catch (e) { sendError(res, e, next); }
});

router.patch('/workspaces/:id/members/:userId', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.userId);
    const newRole = req.body?.role;
    if (!WORKSPACE_ROLE_RANK[newRole]) return res.status(400).json({ error: `role must be one of: ${Object.keys(WORKSPACE_ROLE_RANK).join(', ')}.` });
    const targetRole = await getMembershipRole(targetId, req.workspaceId);
    if (!targetRole) return res.status(404).json({ error: 'Member not found.' });

    const decision = decideMemberChange({
      actorRole: req.workspaceRole, targetRole, newRole, ownerCount: await countOwners(req.workspaceId),
    });
    if (!decision.ok) return res.status(403).json({ error: decision.reason });

    await updateMemberRole(req.workspaceId, targetId, newRole);
    await recordAuditEvent(req, {
      action: 'workspace.member_role_changed', targetType: 'user', targetId: String(targetId),
      metadata: { workspaceId: req.workspaceId, previousRole: targetRole, newRole }, success: true,
    });
    res.json({ userId: targetId, role: newRole });
  } catch (e) { next(e); }
});

// Removes the membership only. The account itself, and any other workspace
// the person belongs to, are untouched; they lose this workspace's projects on
// their very next request (requireAuth re-checks membership every time).
router.delete('/workspaces/:id/members/:userId', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.userId);
    const targetRole = await getMembershipRole(targetId, req.workspaceId);
    if (!targetRole) return res.status(404).json({ error: 'Member not found.' });

    const decision = decideMemberChange({
      actorRole: req.workspaceRole, targetRole, newRole: null, ownerCount: await countOwners(req.workspaceId),
    });
    if (!decision.ok) return res.status(403).json({ error: decision.reason });

    await removeMember(req.workspaceId, targetId);
    await recordAuditEvent(req, {
      action: 'workspace.member_removed', targetType: 'user', targetId: String(targetId),
      metadata: { workspaceId: req.workspaceId, role: targetRole }, success: true,
    });
    res.json({ userId: targetId, removed: true });
  } catch (e) { next(e); }
});

// ───────── hand over ─────────

// Hand the workspace to someone: they become an owner. When the new owner
// already has an account and the caller is a real member (not a platform admin
// helping out), `transfer` also steps the caller down to admin. With an
// invitation the caller stays owner until it is accepted, so the workspace is
// never left without one.
router.post('/workspaces/:id/handover', requireAuth, requireWorkspaceRole('owner'), async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = req.body?.role || 'owner';
    const workspace = await getWorkspaceById(req.workspaceId);
    const result = await grantAccess(req, workspace, email, role);

    let steppedDown = false;
    if (req.body?.transfer && role === 'owner' && result.added && (await getMembershipRole(req.userId, req.workspaceId)) === 'owner') {
      await updateMemberRole(req.workspaceId, req.userId, 'admin');
      steppedDown = true;
    }
    await recordAuditEvent(req, {
      action: 'workspace.handed_over', targetType: 'workspace', targetId: String(req.workspaceId),
      metadata: { workspaceId: req.workspaceId, email, role, steppedDown }, success: true,
    });
    res.status(201).json({ ...result, steppedDown });
  } catch (e) { sendError(res, e, next); }
});

// ───────── API tokens, across the workspace's projects ─────────

router.get('/workspaces/:id/tokens', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    res.json(await listApiTokensForWorkspace(req.workspaceId));
  } catch (e) { next(e); }
});

router.post('/workspaces/:id/tokens', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    const { siteId, label, permissionLevel } = req.body || {};
    const site = Number(siteId);
    if (!Number.isInteger(site) || !(await siteInWorkspace(site, req.workspaceId))) return res.status(404).json({ error: 'Not found.' });
    const level = permissionLevel || DEFAULT_PERMISSION_LEVEL;
    if (!PERMISSION_LEVELS.includes(level)) return res.status(400).json({ error: `Invalid permission level "${level}".` });
    const created = await createApiToken(site, {
      label: label ? String(label).trim().slice(0, 120) : null, createdBy: req.userId, permissionLevel: level,
    });
    await recordAuditEvent(req, {
      action: 'mcp_token.created', targetType: 'api_token', targetId: String(created.id), tenantSiteId: site,
      metadata: { workspaceId: req.workspaceId, label: created.label, permissionLevel: level }, success: true,
    });
    res.status(201).json(created); // includes `token` (raw value), shown once
  } catch (e) { next(e); }
});

router.delete('/workspaces/:id/tokens/:tokenId', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    const tokenId = Number(req.params.tokenId);
    const revoked = Number.isInteger(tokenId) ? await revokeApiTokenInWorkspace(req.workspaceId, tokenId) : null;
    if (!revoked) return res.status(404).json({ error: 'Token not found.' });
    await recordAuditEvent(req, {
      action: 'mcp_token.revoked', targetType: 'api_token', targetId: String(tokenId), tenantSiteId: revoked.site_id,
      metadata: { workspaceId: req.workspaceId, tokenId }, success: true,
    });
    res.json({ revoked: true });
  } catch (e) { next(e); }
});

export default router;
