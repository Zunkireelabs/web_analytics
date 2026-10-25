import { Router } from 'express';
import { requireAuth } from './login.js';
import { getUserById, getUserByEmail } from '../store/users.js';
import { createInvitation } from '../store/user-invitations.js';
import { sendInvitationEmail } from '../report/email.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';
import {
  WORKSPACE_ROLE_RANK, tenantRoleForWorkspaceRole, effectiveWorkspaceRole, roleAtLeast, decideMemberChange,
  getWorkspaceById, getMembershipRole, countOwners, listMembers, listPendingInvitations,
  addMember, updateMemberRole, removeMember, inviteHomeSiteId, createProject,
} from '../store/workspaces.js';

// Workspace management: projects, members, invitations. Every route is
// session-authenticated and then gated by the caller's role IN THAT WORKSPACE
// (member < admin < owner). A caller with no role in the workspace gets a 404,
// not a 403, so a workspace id they do not belong to is never confirmed to
// exist. The workspace is read from the URL, but nothing else is trusted from
// the client: the role comes from workspace_members, never the request.
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

// Members and invitations that are still pending, plus the caller's own role so
// the UI can show or hide management controls (the server enforces them anyway).
router.get('/workspaces/:id/members', requireAuth, requireWorkspaceRole('member'), async (req, res, next) => {
  try {
    const [workspace, members, invitations] = await Promise.all([
      getWorkspaceById(req.workspaceId), listMembers(req.workspaceId), listPendingInvitations(req.workspaceId),
    ]);
    res.json({ workspace, yourRole: req.workspaceRole, members, invitations });
  } catch (e) { next(e); }
});

// A new project inside this workspace. The workspace's existing members
// already have access to it, so no new login is created.
router.post('/workspaces/:id/projects', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    const { name, websiteDomain, timezone } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ error: 'name is required.' });
    if (cleanName.length > 120) return res.status(400).json({ error: 'name is too long.' });
    const domain = websiteDomain ? String(websiteDomain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;

    const site = await createProject({
      workspaceId: req.workspaceId, name: cleanName, websiteDomain: domain, timezone,
    });
    await recordAuditEvent(req, {
      action: 'project.created', targetType: 'site', targetId: String(site.id),
      tenantSiteId: site.id, tenantName: site.name,
      metadata: { workspaceId: req.workspaceId, name: site.name, websiteDomain: site.website_domain }, success: true,
    });
    res.status(201).json({ id: site.id, name: site.name, domain: site.website_domain, workspaceId: req.workspaceId });
  } catch (e) { next(e); }
});

// Invite by email. A person who has no account is emailed a link; a person who
// already has one is added to the workspace straight away (they already
// authenticated with that email, and gain access, never lose it).
router.post('/workspaces/:id/members', requireAuth, requireWorkspaceRole('admin'), async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = req.body?.role || 'member';
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required.' });
    if (!WORKSPACE_ROLE_RANK[role]) return res.status(400).json({ error: `role must be one of: ${Object.keys(WORKSPACE_ROLE_RANK).join(', ')}.` });
    if (role === 'owner' && req.workspaceRole !== 'owner') {
      return res.status(403).json({ error: 'Only an owner can grant ownership.' });
    }

    const workspace = await getWorkspaceById(req.workspaceId);
    const existing = await getUserByEmail(email);
    if (existing) {
      const added = await addMember(req.workspaceId, existing.id, role);
      if (!added) return res.status(409).json({ error: `${email} is already a member of this workspace.` });
      await recordAuditEvent(req, {
        action: 'workspace.member_added', targetType: 'user', targetId: String(existing.id),
        metadata: { workspaceId: req.workspaceId, email, role }, success: true,
      });
      return res.status(201).json({ added: true, email, role });
    }

    const homeSiteId = await inviteHomeSiteId(req.workspaceId, req.siteId);
    if (!homeSiteId) return res.status(400).json({ error: 'Add a project to this workspace before inviting people.' });

    const invitation = await createInvitation({
      siteId: homeSiteId, email, role: tenantRoleForWorkspaceRole(role), invitedBy: req.userId,
      workspaceId: req.workspaceId, workspaceRole: role,
    });
    try {
      await sendInvitationEmail({
        to: email, siteName: workspace.name, role, acceptUrl: `${originOf(req)}/accept-invite?token=${invitation.token}`,
      });
    } catch (err) {
      console.error('[workspaces] invitation email failed:', err.message);
    }
    await recordAuditEvent(req, {
      action: 'workspace.member_invited', targetType: 'user_invitation', targetId: String(invitation.id),
      metadata: { workspaceId: req.workspaceId, email, role }, success: true,
    });
    res.status(201).json({ invited: true, id: invitation.id, email, role, expiresAt: invitation.expires_at });
  } catch (e) { next(e); }
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

export default router;
