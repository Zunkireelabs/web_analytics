import { query, createClientSite } from '../db.js';

// Workspace layer (migrations 191, 192). A workspace owns projects (sites) and
// has members. sites.id stays the unit every route scopes by; this module
// answers "which sites may this user switch into?" and "who may manage this
// workspace?".

export const WORKSPACE_ROLE_RANK = { member: 1, admin: 2, owner: 3 };

// Workspace role -> the tenant role stored on the user row. Existing
// per-project checks (requireTenantRole) still read users.role, so the two
// are kept consistent at the moment a membership is granted.
export function tenantRoleForWorkspaceRole(role) {
  return role === 'member' ? 'tenant_member' : 'tenant_admin';
}

export function isPlatformAdmin(user, companySiteId) {
  return Boolean(user) && user.role === 'platform_admin'
    && Boolean(Number(companySiteId)) && Number(user.site_id) === Number(companySiteId);
}

// The single rule for "may this user act inside this site?". Pure, so the
// isolation guarantee can be tested without a database, and fail-closed: any
// input that does not clearly grant access denies it.
//
//  - platform: a platform_admin whose home site is the company site sees every
//    workspace and project (the Admin area, and support access).
//  - member:   a member of the site's workspace.
//  - legacy-home: a site with no workspace yet (a row the migration has not
//    reached) is reachable only from the user's own home site, i.e. exactly
//    the pre-workspace behaviour.
export function decideSiteAccess({ user, site, membership, companySiteId }) {
  if (!user || !site) return { allowed: false, via: null };
  if (isPlatformAdmin(user, companySiteId)) return { allowed: true, via: 'platform' };
  if (site.workspace_id != null) {
    return membership ? { allowed: true, via: 'member', role: membership.role } : { allowed: false, via: null };
  }
  return Number(user.site_id) === Number(site.id)
    ? { allowed: true, via: 'legacy-home' }
    : { allowed: false, via: null };
}

// The role a user effectively holds in a workspace: a platform admin is an
// owner everywhere (support access, no membership row needed); anyone else
// holds exactly their membership role, or none.
export function effectiveWorkspaceRole({ user, membershipRole, companySiteId }) {
  if (isPlatformAdmin(user, companySiteId)) return 'owner';
  return WORKSPACE_ROLE_RANK[membershipRole] ? membershipRole : null;
}

export function roleAtLeast(role, minRole) {
  return (WORKSPACE_ROLE_RANK[role] || 0) >= (WORKSPACE_ROLE_RANK[minRole] || Infinity);
}

// May `actorRole` change or remove a member? Pure.
//  - needs admin or above;
//  - only an owner may touch an owner, or make someone an owner;
//  - the workspace can never be left without an owner.
// `newRole` is null for a removal.
export function decideMemberChange({ actorRole, targetRole, newRole, ownerCount }) {
  if (!roleAtLeast(actorRole, 'admin')) return { ok: false, reason: 'Only workspace admins can manage members.' };
  if (newRole != null && !WORKSPACE_ROLE_RANK[newRole]) return { ok: false, reason: 'Unknown role.' };
  const touchesOwner = targetRole === 'owner' || newRole === 'owner';
  if (touchesOwner && actorRole !== 'owner') return { ok: false, reason: 'Only an owner can change an owner or grant ownership.' };
  if (targetRole === 'owner' && newRole !== 'owner' && ownerCount <= 1) {
    return { ok: false, reason: 'A workspace needs at least one owner.' };
  }
  return { ok: true };
}

// One row with everything decideSiteAccess needs, for requireAuth's per-
// request check. Null when the user or site does not exist.
export async function getAccessContext(userId, siteId) {
  const { rows } = await query(
    `SELECT u.id AS user_id, u.role AS user_role, u.site_id AS user_site_id,
            s.id AS site_id, s.workspace_id AS site_workspace_id,
            m.role AS membership_role
     FROM users u
     JOIN sites s ON s.id = $2
     LEFT JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = u.id
     WHERE u.id = $1`,
    [userId, siteId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    user: { id: r.user_id, role: r.user_role, site_id: r.user_site_id },
    site: { id: r.site_id, workspace_id: r.site_workspace_id },
    membership: r.membership_role ? { role: r.membership_role } : null,
  };
}

// Workspaces a user can see, each with its projects. A platform admin gets
// every workspace (role 'platform'); anyone else only the ones they belong to.
// Never returns another workspace's projects to a non-member.
export async function listWorkspacesForUser(user, { companySiteId }) {
  const memberCount = '(SELECT count(*)::int FROM workspace_members c WHERE c.workspace_id = w.id)';
  const { rows } = isPlatformAdmin(user, companySiteId)
    ? await query(
      `SELECT w.id, w.name, 'platform' AS role, ${memberCount} AS member_count FROM workspaces w ORDER BY w.name`)
    : await query(
      `SELECT w.id, w.name, m.role, ${memberCount} AS member_count
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.user_id = $1 ORDER BY w.name`, [user.id]);
  if (!rows.length) return [];
  const ids = rows.map((w) => w.id);
  const { rows: projects } = await query(
    `SELECT id, name, website_domain, workspace_id FROM sites
     WHERE workspace_id = ANY($1::int[]) ORDER BY name`, [ids]);
  return rows.map((w) => ({
    id: w.id,
    name: w.name,
    role: w.role,
    memberCount: w.member_count,
    projects: projects.filter((p) => p.workspace_id === w.id)
      .map((p) => ({ id: p.id, name: p.name, domain: p.website_domain })),
  }));
}

// The project a freshly signed-in user lands in: their own home site when they
// can still reach it, otherwise the first project of any workspace they belong
// to. Null when they belong to nothing (e.g. removed from their only
// workspace) — the caller refuses the login rather than creating a session
// that every route would then 403.
export async function pickLoginSite(user, { companySiteId }) {
  const ctx = await getAccessContext(user.id, user.site_id);
  if (ctx && decideSiteAccess({ ...ctx, companySiteId }).allowed) return user.site_id;
  const workspaces = await listWorkspacesForUser(user, { companySiteId });
  return workspaces.flatMap((w) => w.projects)[0]?.id ?? null;
}

export async function getWorkspaceById(id) {
  const { rows } = await query('SELECT id, name FROM workspaces WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function getMembershipRole(userId, workspaceId) {
  const { rows } = await query(
    'SELECT role FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [userId, workspaceId]);
  return rows[0]?.role ?? null;
}

export async function countOwners(workspaceId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`, [workspaceId]);
  return rows[0].n;
}

// Members with the account fields the Team screen needs (never password_hash),
// then invitations that have not been accepted or expired.
export async function listMembers(workspaceId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.status, u.last_login_at, m.role, m.created_at
     FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1 ORDER BY m.created_at, u.id`, [workspaceId]);
  return rows;
}

export async function listPendingInvitations(workspaceId) {
  const { rows } = await query(
    `SELECT id, email, workspace_role AS role, expires_at, created_at
     FROM user_invitations
     WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC`, [workspaceId]);
  return rows;
}

// Returns true when a row was actually inserted (false: already a member).
export async function addMember(workspaceId, userId, role) {
  const { rowCount } = await query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`, [workspaceId, userId, role]);
  return rowCount > 0;
}

export async function updateMemberRole(workspaceId, userId, role) {
  const { rows } = await query(
    `UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2 RETURNING role`,
    [workspaceId, userId, role]);
  return rows[0] || null;
}

export async function removeMember(workspaceId, userId) {
  const { rowCount } = await query(
    'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
  return rowCount > 0;
}

// The project a new invitee's account is created under (their home site):
// prefer the one the inviter is working in when it belongs to this workspace.
export async function inviteHomeSiteId(workspaceId, preferredSiteId) {
  const { rows } = await query(
    `SELECT id FROM sites WHERE workspace_id = $1
     ORDER BY (id = $2) DESC, id LIMIT 1`, [workspaceId, preferredSiteId ?? 0]);
  return rows[0]?.id ?? null;
}

// A new project (site) inside an existing workspace. Its members already have
// access through the workspace, so no login is created.
export async function createProject({ workspaceId, name, websiteDomain, timezone }) {
  return createClientSite({ name, websiteDomain, timezone, propertyType: 'website', workspaceId });
}

// A brand-new client (a site that has just been created together with its
// first login) gets its own workspace, with that login as owner and the site as
// its first project. Mirrors what migration 191 did for the existing sites, so
// a client created tomorrow looks the same as one created before.
export async function attachNewClientWorkspace({ site, userId }) {
  const { rows } = await query(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [site.name]);
  const workspaceId = rows[0].id;
  await query('UPDATE sites SET workspace_id = $1 WHERE id = $2 AND workspace_id IS NULL', [workspaceId, site.id]);
  await addMember(workspaceId, userId, 'owner');
  return workspaceId;
}
