import { query, pool, createClientSite } from '../db.js';

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
export function decideSiteAccess({ user, site, membership, projectMembership, companySiteId }) {
  if (!user || !site) return { allowed: false, via: null };
  if (isPlatformAdmin(user, companySiteId)) return { allowed: true, via: 'platform' };
  if (site.workspace_id != null) {
    // The role is worked out for THIS site: a read-only workspace member who is
    // also an admin of one project is an admin there and read-only everywhere else.
    if (membership) return { allowed: true, via: 'member', role: strongerRole(membership.role, projectMembership?.role) };
    if (projectMembership) return { allowed: true, via: 'project', role: projectMembership.role };
    return { allowed: false, via: null };
  }
  return Number(user.site_id) === Number(site.id)
    ? { allowed: true, via: 'legacy-home' }
    : { allowed: false, via: null };
}

// The higher of two roles (either may be missing).
export function strongerRole(a, b) {
  return (WORKSPACE_ROLE_RANK[a] || 0) >= (WORKSPACE_ROLE_RANK[b] || 0) ? (a || b || null) : b;
}

// The role to check project-level actions against, from a decideSiteAccess
// result: a platform admin is an owner everywhere; anyone else holds the role
// the decision found for this site; no access means no role.
export function siteRoleFromDecision(decision) {
  if (!decision?.allowed) return null;
  if (decision.via === 'platform') return 'owner';
  return decision.role || null;
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
            s.id AS site_id, s.workspace_id AS site_workspace_id, s.status AS site_status,
            m.role AS membership_role, pm.role AS project_role
     FROM users u
     JOIN sites s ON s.id = $2
     LEFT JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = u.id
     LEFT JOIN project_members pm ON pm.site_id = s.id AND pm.user_id = u.id
     WHERE u.id = $1`,
    [userId, siteId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    user: { id: r.user_id, role: r.user_role, site_id: r.user_site_id },
    site: { id: r.site_id, workspace_id: r.site_workspace_id, status: r.site_status },
    membership: r.membership_role ? { role: r.membership_role } : null,
    projectMembership: r.project_role ? { role: r.project_role } : null,
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
     WHERE workspace_id = ANY($1::int[]) AND status IS DISTINCT FROM 'soft_deleted' ORDER BY name`, [ids]);
  return rows.map((w) => ({
    id: w.id,
    name: w.name,
    role: w.role,
    memberCount: w.member_count,
    projects: projects.filter((p) => p.workspace_id === w.id)
      .map((p) => ({ id: p.id, name: p.name, domain: p.website_domain })),
  }));
}

// Every workspace on the platform, for the platform admin's own overview. Cheap
// by design — one pass over workspaces, owners and sites, no per-project calls
// out to Google or GitHub — because it is read whenever the admin opens the
// Platform scope, and the list grows with every client.
//
// "Needs setup" is the plain structural fact (Search Console, Analytics or a
// repo not connected, or no baseline yet), not the live-health judgement the
// workspace overview computes per project. That judgement needs agent-run and
// data-freshness reads per site; across every client it belongs behind a click,
// not on the list.
export async function listAllWorkspacesForPlatform() {
  const [{ rows: workspaces }, { rows: owners }, { rows: sites }] = await Promise.all([
    query(`SELECT w.id, w.name, w.created_at, (SELECT count(*)::int FROM workspace_members c WHERE c.workspace_id = w.id) AS member_count
           FROM workspaces w ORDER BY w.name`),
    query(`SELECT m.workspace_id, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
           WHERE m.role = 'owner' ORDER BY u.email`),
    query(`SELECT id, name, website_domain, workspace_id, gsc_property, ga4_property_id, repo_owner, repo_name, onboarded_at
           FROM sites WHERE workspace_id IS NOT NULL AND status IS DISTINCT FROM 'soft_deleted' ORDER BY name`),
  ]);
  return workspaces.map((w) => {
    const projects = sites.filter((s) => s.workspace_id === w.id).map((s) => {
      const missing = [];
      if (!s.gsc_property) missing.push('Search Console');
      if (!s.ga4_property_id) missing.push('Analytics');
      if (!(s.repo_owner && s.repo_name)) missing.push('GitHub');
      if (!s.onboarded_at) missing.push('Baseline');
      return { id: s.id, name: s.name, domain: s.website_domain, missing };
    });
    return {
      id: w.id, name: w.name, createdAt: w.created_at, memberCount: w.member_count,
      owners: owners.filter((o) => o.workspace_id === w.id).map((o) => o.email),
      projects,
      needsSetup: projects.filter((p) => p.missing.length).length,
    };
  });
}

// The project a freshly signed-in user lands in: their own home site when they
// can still reach it, otherwise the first project of any workspace they belong
// to. Null when they belong to nothing (e.g. removed from their only
// workspace) — the caller refuses the login rather than creating a session
// that every route would then 403.
export async function pickLoginSite(user, { companySiteId }) {
  // A new account has no home site yet (users.site_id is NULL, migration 198):
  // nothing to check, go straight to the workspaces it belongs to (none, at first).
  if (user.site_id != null) {
    const ctx = await getAccessContext(user.id, user.site_id);
    // A home project that has been deleted (or suspended) is not somewhere to land: fall through to another.
    if (ctx && (ctx.site.status ?? 'active') === 'active' && decideSiteAccess({ ...ctx, companySiteId }).allowed) return user.site_id;
  }
  const workspaces = await listWorkspacesForUser(user, { companySiteId });
  const own = workspaces.flatMap((w) => w.projects)[0]?.id;
  if (own != null) return own;
  return (await listSharedProjectsForUser(user, { companySiteId }))[0]?.id ?? null;
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
    `SELECT id, email, COALESCE(project_role, workspace_role) AS role, project_site_ids, expires_at, created_at
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
    `SELECT id FROM sites WHERE workspace_id = $1 AND status = 'active'
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

// ───────── creating and renaming workspaces ─────────

// A new, empty workspace. The caller decides who owns it (the creator, or an
// invited client when a platform admin sets one up on their behalf).
export async function createWorkspace({ name }) {
  const { rows } = await query('INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name', [name]);
  return rows[0];
}

// Takes back a workspace (and the project made with it) that was created in a request which then failed
// part-way, so a retry does not leave an orphan workspace behind or make a second one. Only ever called
// for rows made in that same request, BEFORE the person's home project was set (deleting a home project
// would delete the person), and in one transaction so it is all or nothing.
export async function discardNewWorkspace({ workspaceId, siteId = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (siteId != null) await client.query('DELETE FROM sites WHERE id = $1 AND workspace_id = $2', [siteId, workspaceId]);
    await client.query('DELETE FROM workspace_members WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Is this website already a (live) project of this workspace? The unique index (migration 210) is the
// real guard, but it can be absent where old data had duplicates, so the route asks first as well.
export async function workspaceHasDomain(workspaceId, domain) {
  if (!domain) return false;
  const { rows } = await query(
    `SELECT 1 FROM sites WHERE workspace_id = $1 AND lower(website_domain) = lower($2) AND status IS DISTINCT FROM 'soft_deleted' LIMIT 1`,
    [workspaceId, domain]);
  return rows.length > 0;
}

export async function renameWorkspace(workspaceId, name) {
  const { rows } = await query('UPDATE workspaces SET name = $2 WHERE id = $1 RETURNING id, name', [workspaceId, name]);
  return rows[0] || null;
}

// Is this site a project of this workspace? Every workspace-scoped route that
// takes a siteId runs it through here, so a project id from another workspace
// is never acted on (and never confirmed to exist).
export async function siteInWorkspace(siteId, workspaceId) {
  const { rows } = await query('SELECT 1 FROM sites WHERE id = $1 AND workspace_id = $2', [siteId, workspaceId]);
  return rows.length > 0;
}

// ───────── read-only access ─────────

// A "member" (read-only) of a workspace or of a project can open everything they
// have access to but change nothing. Enforced in one place (requireAuth) so no
// write route has to remember it. Fail-closed: anything that is not a plain read
// is refused unless it is a personal/account action listed below.
//
// /api/workspaces/:id/... and /api/projects/:id/... are exempt on purpose: every
// write there is gated by requireWorkspaceRole / requireProjectRole against the
// workspace or project in the URL, which is the right thing to check (the
// person's role in the ACTIVE project says nothing about a different workspace
// they own).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ_ONLY_ALLOWED_WRITES = [
  /^\/api\/logout\/?$/,
  /^\/api\/workspaces\/switch\/?$/,
  /^\/api\/workspaces\/?$/, // creating a workspace of their own
  /^\/api\/workspaces\/\d+(\/|$)/, // role-checked per workspace in the route
  /^\/api\/projects\/\d+(\/|$)/, // role-checked per project in the route
  /^\/api\/change-password\/?$/,
  /^\/api\/verify-password\/?$/,
  /^\/api\/notifications(\/|$)/,
];

// What a signed-in person with NO project yet may call. Someone approved from a
// sign-up request has a login and nothing else until they create a workspace and
// a project, so requireAuth (which resolves a site for every request) lets them
// through only here. Each of these checks the person's real workspace or project
// role itself, so none of them depends on there being an active site:
//   - their account chrome (sign out, password),
//   - listing their workspaces and creating one,
//   - anything under one workspace or one project (role-checked in the route),
//   - switching into a project once they have made one.
// Everything else — every data route — stays a 403 until they have a project.
const NO_PROJECT_ALLOWED = [
  { methods: null, re: /^\/api\/logout\/?$/ },
  { methods: null, re: /^\/api\/change-password\/?$/ },
  { methods: null, re: /^\/api\/verify-password\/?$/ },
  { methods: ['GET', 'POST'], re: /^\/api\/workspaces\/?$/ },
  { methods: ['POST'], re: /^\/api\/workspaces\/switch\/?$/ },
  { methods: null, re: /^\/api\/workspaces\/\d+(\/|$)/ },
  { methods: null, re: /^\/api\/projects\/\d+(\/|$)/ },
  // Google/GitHub send the browser back here after "Connect". A person on
  // their first project may have no active site yet; the handlers verify the
  // single-use nonce and the user themselves, so they must not 403 as JSON.
  { methods: ['GET'], re: /^\/api\/(google|github)\/callback\/?$/ },
];

export function isAllowedWithoutProject({ method, path }) {
  const clean = String(path || '').split('?')[0];
  const verb = String(method || '').toUpperCase();
  return NO_PROJECT_ALLOWED.some((r) => r.re.test(clean) && (!r.methods || r.methods.includes(verb)));
}

// The first project a person creates becomes their home site, so the rest of the
// app (which still reads users.site_id) sees a normal account from then on. Only
// ever fills a NULL — a person who already has a home never has it moved.
export async function claimHomeSiteIfNone(userId, siteId) {
  const { rowCount } = await query('UPDATE users SET site_id = $2 WHERE id = $1 AND site_id IS NULL', [userId, siteId]);
  return rowCount === 1;
}

export function isBlockedForReadOnly({ via, role, method, path }) {
  if ((via !== 'member' && via !== 'project') || role !== 'member') return false;
  if (SAFE_METHODS.has(String(method).toUpperCase())) return false;
  const clean = String(path || '').split('?')[0];
  return !READ_ONLY_ALLOWED_WRITES.some((re) => re.test(clean));
}

// ───────── plain-language goals ─────────

export const GOAL_KEYS = ['google_visitors', 'enquiries', 'ai_answers', 'key_rankings'];
export const GOAL_GROWTH = ['steady', 'fast', 'ambitious'];
export const GOAL_MONTHS = [3, 6, 12];

// A goal written in the person's own words (migration 196). Capped because it
// is shown back in lists and cards, not stored as free-form content.
export const GOAL_CUSTOM_MAX = 140;

export function validateGoal(input) {
  const growth = input?.growth, months = Number(input?.months);
  if (!GOAL_MONTHS.includes(months)) return { ok: false, reason: `months must be one of: ${GOAL_MONTHS.join(', ')}.` };

  // A person can aim at several things at once (migration 199). `goals` is the list,
  // in the order they were ticked; the older single `goal` is still accepted as a list
  // of one, so existing callers and stored rows keep working unchanged.
  const raw = Array.isArray(input?.goals) ? input.goals : input?.goal != null ? [input.goal] : [];
  const goals = [...new Set(raw)];
  if (!goals.length) return { ok: false, reason: `Choose at least one goal: ${[...GOAL_KEYS, 'custom'].join(', ')}.` };
  const bad = goals.find((g) => g !== 'custom' && !GOAL_KEYS.includes(g));
  if (bad !== undefined) return { ok: false, reason: `goal must be one of: ${[...GOAL_KEYS, 'custom'].join(', ')}.` };

  // 'custom' carries its own sentence (see 196). Growth only means something for the
  // preset goals, so a goal list that is custom alone stores the neutral 'steady'.
  const hasCustom = goals.includes('custom');
  let customText = null;
  if (hasCustom) {
    customText = String(input?.customText ?? '').trim().replace(/\s+/g, ' ');
    if (!customText) return { ok: false, reason: 'customText is required when goal is "custom".' };
    if (customText.length > GOAL_CUSTOM_MAX) return { ok: false, reason: `customText must be ${GOAL_CUSTOM_MAX} characters or fewer.` };
  }
  const hasPreset = goals.some((g) => g !== 'custom');
  if (hasPreset && !GOAL_GROWTH.includes(growth)) return { ok: false, reason: `growth must be one of: ${GOAL_GROWTH.join(', ')}.` };

  return { ok: true, goal: { goal: goals[0], goals, growth: hasPreset ? growth : 'steady', months, customText } };
}

// Replacing a goal supersedes the active row (history stays queryable) in one
// transaction, so a project never has two active goals.
export async function setProjectGoal({ siteId, goal, goals = null, growth, months, customText = null, userId }) {
  // The primary goal is always the first of the list (the table enforces it).
  const list = Array.isArray(goals) && goals.length ? goals : [goal];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE project_goals SET status = 'superseded' WHERE site_id = $1 AND status = 'active'`, [siteId]);
    const { rows } = await client.query(
      `INSERT INTO project_goals (site_id, goal, goals, growth, months, custom_text, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING site_id, goal, goals, growth, months, custom_text, created_at`,
      [siteId, list[0], list, growth, months, list.includes('custom') ? customText : null, userId ?? null]);
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listGoalsForSites(siteIds) {
  if (!siteIds.length) return {};
  const { rows } = await query(
    `SELECT site_id, goal, goals, growth, months, custom_text, created_at FROM project_goals
     WHERE status = 'active' AND site_id = ANY($1::int[])`, [siteIds]);
  return Object.fromEntries(rows.map((r) => [r.site_id, {
    // Rows written before migration 199 have no list: their one goal IS the list.
    goal: r.goal, goals: r.goals ?? [r.goal], growth: r.growth, months: r.months, customText: r.custom_text, createdAt: r.created_at,
  }]));
}

// ───────── workspace health and activity ─────────

const DAY_MS = 86400000;

// The four plain checks shown for each project. Pure, so the wording and the
// thresholds can be tested without a database.
//   state: 'ok' (all good) | 'warn' (needs attention) | 'pending' (nothing to judge yet)
export function summarizeProjectHealth({ site, dataAsOf, agentFailures24h = 0, now = Date.now() }) {
  const gsc = Boolean(site.gsc_property);
  const ga4 = Boolean(site.ga4_property_id);
  const asOfMs = dataAsOf ? new Date(`${String(dataAsOf).slice(0, 10)}T00:00:00Z`).getTime() : null;
  const ageDays = asOfMs == null ? null : Math.floor((now - asOfMs) / DAY_MS);

  const freshness = asOfMs == null
    ? { state: 'warn', text: 'No data yet' }
    // Search Console data trails by a couple of days, so only flag it as stale past 5.
    : ageDays <= 5 ? { state: 'ok', text: ageDays <= 1 ? 'Up to date' : `Updated ${ageDays} days ago` }
      : { state: 'warn', text: `Last data ${ageDays} days ago` };

  const agents = !gsc && !ga4 ? { state: 'pending', text: 'Waiting for data' }
    : agentFailures24h > 0 ? { state: 'warn', text: `${agentFailures24h} ${agentFailures24h === 1 ? 'run' : 'runs'} failed in 24h` }
      : { state: 'ok', text: 'Running normally' };

  const checks = [
    { key: 'search_console', label: 'Google Search Console', ...(gsc ? { state: 'ok', text: 'Connected' } : { state: 'warn', text: 'Not connected' }) },
    { key: 'analytics', label: 'Google Analytics', ...(ga4 ? { state: 'ok', text: 'Connected' } : { state: 'warn', text: 'Not connected' }) },
    { key: 'data', label: 'Fresh data', ...freshness },
    { key: 'agents', label: 'AI agents', ...agents },
  ];
  return { status: checks.some((c) => c.state === 'warn') ? 'attention' : 'healthy', checks };
}

export async function listWorkspaceSites(workspaceId) {
  const { rows } = await query(
    `SELECT id, name, website_domain, gsc_property, ga4_property_id FROM sites
     WHERE workspace_id = $1 AND status IS DISTINCT FROM 'soft_deleted' ORDER BY name`, [workspaceId]);
  return rows;
}

// Recent changes in a workspace, from the append-only audit log: anything
// recorded against one of its projects, or tagged with this workspace id.
export async function listWorkspaceActivity(workspaceId, siteIds, limit = 20) {
  const { rows } = await query(
    `SELECT id, action, actor_email, tenant_name, metadata, created_at
       FROM audit_log
      WHERE success = true
        AND (tenant_site_id = ANY($1::int[]) OR metadata->>'workspaceId' = $2)
      ORDER BY created_at DESC LIMIT $3`,
    [siteIds, String(workspaceId), limit]);
  return rows;
}

const ROLE_WORDS = { owner: 'Owner', admin: 'Admin', member: 'Read-only' };

// One audit row -> one plain sentence for the Monitoring tab ("<actor> <text>").
// Returns null for actions that are not worth showing a workspace.
export function describeActivity(row) {
  const m = row.metadata || {};
  const role = ROLE_WORDS[m.role] || ROLE_WORDS[m.newRole] || m.role || '';
  const project = m.name || row.tenant_name || 'a project';
  const table = {
    'workspace.created': ['building', 'created this workspace'],
    'workspace.renamed': ['building', `renamed this workspace to “${m.name}”`],
    'workspace.handed_over': ['swap', `handed this workspace over to ${m.email}`],
    'project.created': ['folderplus', `added the project ${project}`],
    'project.goal_set': ['target', `set a goal for ${row.tenant_name || project}`],
    'workspace.member_added': ['userplus', `gave ${role} access to ${m.email}`],
    'workspace.member_invited': ['mail', `invited ${m.email} as ${role}`],
    'workspace.member_role_changed': ['users', `changed someone’s access to ${ROLE_WORDS[m.newRole] || m.newRole}`],
    'workspace.member_removed': ['users', 'removed someone’s access'],
    'project.transferred': ['swap', `moved ${project} to another workspace`],
    'project.member_added': ['userplus', `gave ${role} access to ${m.email} (${project} only)`],
    'project.member_invited': ['mail', `invited ${m.email} to ${project} as ${role}`],
    'project.member_role_changed': ['users', `changed someone’s access to ${project} to ${ROLE_WORDS[m.newRole] || m.newRole}`],
    'project.member_removed': ['users', `removed someone’s access to ${project}`],
    'mcp_token.created': ['key', `created the API token “${m.label || 'Unnamed'}” for ${row.tenant_name || 'a project'}`],
    'mcp_token.revoked': ['key', `revoked an API token for ${row.tenant_name || 'a project'}`],
  }[row.action];
  if (!table) return null;
  return { id: row.id, icon: table[0], actorEmail: row.actor_email || null, text: table[1], createdAt: row.created_at };
}


// ───────── project-level access ─────────

export async function getProject(siteId) {
  const { rows } = await query(
    // Everything the connect screens report on (what is connected, which repo and
    // branch, whether the baseline ran), so a project that is already set up is
    // never shown as "not connected" for want of a column.
    `SELECT id, name, website_domain, workspace_id, status, gsc_property, ga4_property_id,
            repo_owner, repo_name, repo_default_branch, pr_target_branch, tech_stack, github_app_installation_id,
            onboarded_at, baseline_run_id, action_center_config_gap_count, action_center_config_checked_at
       FROM sites WHERE id = $1`, [siteId]);
  return rows[0] || null;
}

// Projects a person can open only because they were given access to the project
// itself (not through a workspace they belong to). This is what the switcher
// shows under "Shared with you": nothing about the workspace that holds them.
// A platform admin already sees everything, so they get none.
export async function listSharedProjectsForUser(user, { companySiteId }) {
  if (isPlatformAdmin(user, companySiteId)) return [];
  const { rows } = await query(
    `SELECT s.id, s.name, s.website_domain, pm.role
       FROM project_members pm JOIN sites s ON s.id = pm.site_id
      WHERE pm.user_id = $1 AND s.status IS DISTINCT FROM 'soft_deleted'
        AND (s.workspace_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM workspace_members m WHERE m.workspace_id = s.workspace_id AND m.user_id = $1))
      ORDER BY s.name`, [user.id]);
  return rows.map((r) => ({ id: r.id, name: r.name, domain: r.website_domain, role: r.role }));
}

// Deleting a project, as a person sees it: it disappears from their workspace and the agent stops.
// Underneath it is the app's own soft-delete (the same end state as suspend -> soft-delete in the admin
// screen, in one atomic statement), NOT a destructive delete: everything stored for the project is kept, so
// SuperRank can restore it with reactivateSite if it was a mistake, and only a platform admin can remove it
// for good. Only an ACTIVE or SUSPENDED project can be deleted; anything else returns false.
export async function softDeleteProject(siteId) {
  const { rowCount } = await query(
    `UPDATE sites
        SET status = 'soft_deleted', deleted_at = now(), deactivated_at = COALESCE(deactivated_at, now())
      WHERE id = $1 AND status IN ('active', 'suspended')`, [siteId]);
  return rowCount === 1;
}

export async function getProjectMembershipRole(userId, siteId) {
  const { rows } = await query('SELECT role FROM project_members WHERE user_id = $1 AND site_id = $2', [userId, siteId]);
  return rows[0]?.role ?? null;
}

export async function listProjectMembers(siteId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.status, u.last_login_at, pm.role, pm.created_at
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.site_id = $1 ORDER BY pm.created_at, u.id`, [siteId]);
  return rows;
}

// One row per (person, project) for everyone whose access to this workspace is
// limited to specific projects, for the "Project access only" group on the
// People tab.
export async function listProjectMembersForWorkspace(workspaceId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.status, u.last_login_at, pm.role, pm.created_at, s.id AS site_id, s.name AS site_name
       FROM project_members pm
       JOIN sites s ON s.id = pm.site_id AND s.workspace_id = $1
       JOIN users u ON u.id = pm.user_id
      ORDER BY s.name, pm.created_at, u.id`, [workspaceId]);
  return rows.map((r) => ({ id: r.id, email: r.email, status: r.status, last_login_at: r.last_login_at, role: r.role, created_at: r.created_at, project: { id: r.site_id, name: r.site_name } }));
}

export async function listPendingInvitationsForProject(siteId) {
  const { rows } = await query(
    `SELECT id, email, project_role AS role, expires_at, created_at
       FROM user_invitations
      WHERE accepted_at IS NULL AND expires_at > now() AND project_site_ids @> ARRAY[$1]::int[]
      ORDER BY created_at DESC`, [siteId]);
  return rows;
}

// Returns true when a row was actually inserted (false: already has access).
export async function addProjectMember(siteId, userId, role, createdBy = null) {
  const { rowCount } = await query(
    `INSERT INTO project_members (site_id, user_id, role, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, user_id) DO NOTHING`, [siteId, userId, role, createdBy]);
  return rowCount > 0;
}

export async function updateProjectMemberRole(siteId, userId, role) {
  const { rows } = await query(
    'UPDATE project_members SET role = $3 WHERE site_id = $1 AND user_id = $2 RETURNING role', [siteId, userId, role]);
  return rows[0] || null;
}

export async function removeProjectMember(siteId, userId) {
  const { rowCount } = await query('DELETE FROM project_members WHERE site_id = $1 AND user_id = $2', [siteId, userId]);
  return rowCount > 0;
}

// Recent changes to one project, from the append-only audit log.
export async function listProjectActivity(siteId, limit = 20) {
  const { rows } = await query(
    `SELECT id, action, actor_email, tenant_name, metadata, created_at
       FROM audit_log WHERE success = true AND tenant_site_id = $1
      ORDER BY created_at DESC LIMIT $2`, [siteId, limit]);
  return rows;
}


// ───────── transferring a project to another workspace ─────────

const PROJECT_ROLE_FOR_WORKSPACE_ROLE = { owner: 'admin', admin: 'admin', member: 'member' };

// Pure: what a transfer will do, so it can be reviewed and tested before anything runs.
// With keepAccess, everyone in the OLD workspace who is not already in the new one
// keeps access to just this project (owner/admin -> project admin, member ->
// project read-only), so moving a project never locks anyone out.
export function planProjectTransfer({ site, source, target, sourceMembers, targetMemberIds, keepAccess = true }) {
  const problems = [];
  if (!site) problems.push('That project does not exist.');
  if (!target) problems.push('The target workspace does not exist.');
  if (site && target && site.workspace_id === target.id) problems.push(`${site.name} is already in ${target.name}.`);
  const grants = [];
  const alreadyInTarget = [];
  for (const m of sourceMembers || []) {
    if ((targetMemberIds || []).includes(m.user_id)) { alreadyInTarget.push(m.email); continue; }
    if (keepAccess) grants.push({ userId: m.user_id, email: m.email, workspaceRole: m.role, projectRole: PROJECT_ROLE_FOR_WORKSPACE_ROLE[m.role] || 'member' });
  }
  return { ok: problems.length === 0, problems, site, source, target, grants, alreadyInTarget, keepAccess };
}

// Moves the project and records the access grants in ONE transaction. Nothing else
// about the project moves because nothing else needs to: every project table is
// keyed by site id, and the workspace is only a pointer on the site.
export async function transferProject({ siteId, toWorkspaceId, keepAccess = true, createdBy = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const one = async (sql, params) => (await client.query(sql, params)).rows[0] || null;
    const site = await one('SELECT id, name, workspace_id FROM sites WHERE id = $1 FOR UPDATE', [siteId]);
    const target = await one('SELECT id, name FROM workspaces WHERE id = $1', [toWorkspaceId]);
    const source = site?.workspace_id ? await one('SELECT id, name FROM workspaces WHERE id = $1', [site.workspace_id]) : null;
    const sourceMembers = source ? (await client.query(
      `SELECT m.user_id, m.role, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.user_id`, [source.id])).rows : [];
    const targetMemberIds = target ? (await client.query('SELECT user_id FROM workspace_members WHERE workspace_id = $1', [target.id])).rows.map((r) => r.user_id) : [];
    const plan = planProjectTransfer({ site, source, target, sourceMembers, targetMemberIds, keepAccess });
    if (!plan.ok) { await client.query('ROLLBACK'); return plan; }
    await client.query('UPDATE sites SET workspace_id = $1 WHERE id = $2', [target.id, site.id]);
    for (const g of plan.grants) {
      await client.query(
        `INSERT INTO project_members (site_id, user_id, role, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (site_id, user_id) DO NOTHING`,
        [site.id, g.userId, g.projectRole, createdBy]);
    }
    await client.query('COMMIT');
    return plan;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
