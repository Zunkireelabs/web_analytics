import { getUserByEmail } from '../../store/users.js';
import { createInvitation } from '../../store/user-invitations.js';
import { sendInvitationEmail } from '../../report/email.js';
import { recordAuditEvent } from '../../store/admin/audit-log.js';
import { tenantRoleForWorkspaceRole, getMembershipRole, addProjectMember, getProject } from '../../store/workspaces.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const PROJECT_ROLES = ['admin', 'member'];
const originOf = (req) => `${req.protocol}://${req.get('host')}`;

// Give one person access to specific projects of a workspace, without making them
// a member of the workspace. A person with an account is added straight away; a
// new email gets an invitation whose home project is the first one, and accepting
// it creates the account with access to just those projects.
//
// The invitation email names the PROJECT, never the workspace, so a project-only
// person is never told the name of the workspace (or anything else) that holds it.
//
// `siteIds` must already be checked to belong to `workspace` by the caller.
// Throws HttpError; returns what happened.
export async function grantProjectAccess(req, workspace, email, role, siteIds) {
  if (!email || !email.includes('@')) throw new HttpError(400, 'A valid email is required.');
  if (!PROJECT_ROLES.includes(role)) throw new HttpError(400, 'Project access is either admin or read-only.');
  if (!siteIds.length) throw new HttpError(400, 'Pick at least one project.');

  const existing = await getUserByEmail(email);
  if (existing) {
    // Someone who already belongs to the whole workspace has this access already.
    if (await getMembershipRole(existing.id, workspace.id)) {
      throw new HttpError(409, `${email} already has access to the whole workspace.`);
    }
    let added = 0;
    for (const siteId of siteIds) {
      if (await addProjectMember(siteId, existing.id, role, req.userId)) {
        added += 1;
        await recordAuditEvent(req, {
          action: 'project.member_added', targetType: 'user', targetId: String(existing.id), tenantSiteId: siteId,
          metadata: { workspaceId: workspace.id, email, role }, success: true,
        });
      }
    }
    if (!added) throw new HttpError(409, `${email} already has access to ${siteIds.length === 1 ? 'this project' : 'these projects'}.`);
    return { added: true, email, role, projects: siteIds };
  }

  const invitation = await createInvitation({
    siteId: siteIds[0], email, role: tenantRoleForWorkspaceRole(role), invitedBy: req.userId,
    workspaceId: workspace.id, projectSiteIds: siteIds, projectRole: role,
  });
  try {
    const first = await getProject(siteIds[0]);
    await sendInvitationEmail({ to: email, siteName: first?.name || 'a project', role, acceptUrl: `${originOf(req)}/accept-invite?token=${invitation.token}` });
  } catch (err) {
    console.error('[projects] invitation email failed:', err.message);
  }
  await recordAuditEvent(req, {
    action: 'project.member_invited', targetType: 'user_invitation', targetId: String(invitation.id), tenantSiteId: siteIds[0],
    metadata: { workspaceId: workspace.id, email, role }, success: true,
  });
  return { invited: true, id: invitation.id, email, role, projects: siteIds, expiresAt: invitation.expires_at };
}
