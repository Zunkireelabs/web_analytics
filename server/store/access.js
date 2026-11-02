import { query } from '../db.js';
import { recordAuditEvent } from './admin/audit-log.js';
import { normalizeDomain } from '../util/domain.js';

// Who may use a project, and for how long (migration 219). The free-trial flow:
//
//   pending   made on /get-started; the owner sees their Overview and a lock on the rest. They press "Request access".
//   demo      approved for DEMO_DAYS days: the whole dashboard. When the days run out it becomes 'ended'.
//   ended     a finished demo: the Overview as it stood, and nothing else. Google and GitHub were disconnected.
//   client    approved for good, and the state of every project that was not made on /get-started.
//   rejected  staff said no; the lock stays.
//
// The rules that need no database are exported separately so they can be tested without one.

export const DEMO_DAYS = 15;
export const ACCESS_STATES = ['pending', 'demo', 'ended', 'client', 'rejected'];
const DAY_MS = 24 * 60 * 60 * 1000;

// A demo whose last moment has passed is 'ended' even if the job that records it has not run yet, so nothing waits on
// a schedule to lock someone out.
export function effectiveState(row, now = new Date()) {
  const state = ACCESS_STATES.includes(row?.access_state) ? row.access_state : 'client';
  if (state === 'demo' && row.access_ends_at && new Date(row.access_ends_at).getTime() <= now.getTime()) return 'ended';
  return state;
}

export const isLocked = (state) => state === 'pending' || state === 'ended' || state === 'rejected';

export function daysLeft(row, now = new Date()) {
  if (effectiveState(row, now) !== 'demo' || !row.access_ends_at) return null;
  return Math.max(0, Math.ceil((new Date(row.access_ends_at).getTime() - now.getTime()) / DAY_MS));
}

// What staff's decision changes. `type` is 'demo' or 'client'; nothing else is a way to approve.
export function planApproval({ type, githubOptional = false }, now = new Date()) {
  if (type === 'demo') return { state: 'demo', endsAt: new Date(now.getTime() + DEMO_DAYS * DAY_MS), githubOptional: Boolean(githubOptional) };
  if (type === 'client') return { state: 'client', endsAt: null, githubOptional: false };
  return null;
}

// While a project is locked, a signed-in person can still sign out, switch project, read what the Overview shows,
// and ask for access. Everything else (every other page's data, every change) is refused. One list, so a route does
// not have to remember to check.
const ALLOWED_WHILE_LOCKED = [
  { re: /^\/api\/me\/?$/, methods: ['GET'] },
  { re: /^\/api\/access(\/|$)/, methods: ['GET', 'POST'] },
  { re: /^\/api\/onboarding\/summary\/?$/, methods: ['GET'] },
  { re: /^\/api\/get-started\/resume\/?$/, methods: ['GET'] },
  { re: /^\/api\/onboarding\/draft\/?$/, methods: ['GET', 'PUT', 'DELETE'] },
  // Finishing /get-started again (same email, waiting project) just updates the request; a new site makes a new pending one.
  { re: /^\/api\/onboarding\/complete\/?$/, methods: ['POST'] },
  { re: /^\/api\/(logout|change-password|verify-password)\/?$/, methods: null },
  { re: /^\/api\/workspaces\/switch\/?$/, methods: ['POST'] },
  { re: /^\/api\/workspaces(\/|$)/, methods: ['GET'] },
  { re: /^\/api\/projects\/\d+\/?$/, methods: ['GET'] },
  { re: /^\/api\/sites\/?$/, methods: ['GET'] },
  { re: /^\/api\/notifications(\/|$)/, methods: ['GET', 'POST'] },
  // What the Overview shows
  { re: /^\/api\/(range|series|channels|breakdown-range|baseline-report)(\/|$)/, methods: ['GET'] },
];
export function isAllowedWhileLocked({ method, path }) {
  const clean = String(path || '').split('?')[0];
  const verb = String(method || '').toUpperCase();
  return ALLOWED_WHILE_LOCKED.some((r) => r.re.test(clean) && (!r.methods || r.methods.includes(verb)));
}

// ───────── database ─────────

const COLUMNS = `id, name, website_domain, workspace_id, access_state, access_source, access_requested_at, access_ends_at,
  access_ended_at, access_decided_at, access_decided_by, access_github_optional`;

// The project's access row. A demo past its end is recorded as ended here (and its connections removed), so
// the first request after the deadline does the work even if the schedule has not.
export async function getSiteAccess(siteId, { now = new Date() } = {}) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM sites WHERE id = $1`, [siteId]);
  const row = rows[0];
  if (!row) return null;
  if (row.access_state === 'demo' && effectiveState(row, now) === 'ended') {
    await endDemo(siteId, { reason: 'expired' });
    return (await query(`SELECT ${COLUMNS} FROM sites WHERE id = $1`, [siteId])).rows[0];
  }
  return row;
}

export function describeAccess(row, now = new Date()) {
  if (!row) return null;
  const state = effectiveState(row, now);
  return {
    state,
    locked: isLocked(state),
    requested: Boolean(row.access_requested_at),
    requestedAt: row.access_requested_at,
    endsAt: state === 'demo' || state === 'ended' ? row.access_ends_at : null,
    // When it actually stopped (staff can end a demo early, before its date).
    endedAt: state === 'ended' ? (row.access_ended_at || row.access_ends_at) : null,
    daysLeft: daysLeft(row, now),
    githubOptional: Boolean(row.access_github_optional),
    // 'get-started' for a project made on the marketing site: its GitHub step can only be skipped when staff allowed it.
    source: row.access_source || null,
  };
}

// A new project from /get-started waits for a decision. Finishing Get Started IS the request, so staff see it at once.
export async function markPending(siteId, { source = 'get-started', requested = false } = {}) {
  await query(
    `UPDATE sites SET access_state = 'pending', access_source = $2, access_requested_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
            access_ends_at = NULL, access_ended_at = NULL, access_decided_at = NULL, access_decided_by = NULL
      WHERE id = $1`, [siteId, source, requested]);
}

// Who to email about a project: its owner.
export async function getOwnerContact(siteId) {
  const { rows } = await query(
    `SELECT s.name, s.website_domain, u.email, u.display_name
       FROM sites s LEFT JOIN LATERAL (
         SELECT us.email, us.display_name FROM workspace_members m JOIN users us ON us.id = m.user_id
          WHERE m.workspace_id = s.workspace_id AND m.role = 'owner' ORDER BY m.user_id LIMIT 1
       ) u ON true WHERE s.id = $1`, [siteId]);
  return rows[0] ? { name: rows[0].name, websiteDomain: rows[0].website_domain, email: rows[0].email, displayName: rows[0].display_name } : null;
}

// The person pressed "Request access". Asking twice changes nothing (and a project that was already decided is left
// alone). Returns true only when this call is the one that made the request.
export async function requestAccess(siteId) {
  const { rowCount } = await query(
    `UPDATE sites SET access_requested_at = now() WHERE id = $1 AND access_state = 'pending' AND access_requested_at IS NULL`, [siteId]);
  return rowCount === 1;
}

export async function approveAccess(siteId, { type, githubOptional = false, decidedBy }, now = new Date()) {
  const plan = planApproval({ type, githubOptional }, now);
  if (!plan) throw new Error('Choose demo or client.');
  const { rows } = await query(
    `UPDATE sites SET access_state = $2, access_ends_at = $3, access_ended_at = NULL, access_github_optional = $4,
            access_decided_at = now(), access_decided_by = $5,
            access_requested_at = COALESCE(access_requested_at, now())
      WHERE id = $1 AND access_state IN ('pending', 'ended', 'rejected', 'demo')
      RETURNING ${COLUMNS}`,
    [siteId, plan.state, plan.endsAt, plan.githubOptional, decidedBy ?? null]);
  return rows[0] || null;
}

// A client is always a client: make-client works from any state, but never turns a client back into a demo.
export async function makeClient(siteId, { decidedBy }) {
  const { rows } = await query(
    `UPDATE sites SET access_state = 'client', access_ends_at = NULL, access_ended_at = NULL, access_github_optional = false,
            access_decided_at = now(), access_decided_by = $2, access_requested_at = COALESCE(access_requested_at, now())
      WHERE id = $1 AND access_state <> 'client' RETURNING ${COLUMNS}`, [siteId, decidedBy ?? null]);
  return rows[0] || null;
}

export async function rejectAccess(siteId, { decidedBy }) {
  const { rows } = await query(
    `UPDATE sites SET access_state = 'rejected', access_decided_at = now(), access_decided_by = $2
      WHERE id = $1 AND access_state = 'pending' RETURNING ${COLUMNS}`, [siteId, decidedBy ?? null]);
  return rows[0] || null;
}

// Ending a demo: record it, then remove what the person connected so nothing of theirs keeps being read or changed.
export async function endDemo(siteId, { reason = 'staff', decidedBy = null } = {}) {
  const { rows } = await query(
    `UPDATE sites SET access_state = 'ended', access_ended_at = now(),
            access_decided_at = CASE WHEN $2::int IS NULL THEN access_decided_at ELSE now() END,
            access_decided_by = COALESCE($2::int, access_decided_by)
      WHERE id = $1 AND access_state = 'demo' RETURNING ${COLUMNS}`, [siteId, decidedBy]);
  if (!rows[0]) return null;
  const removed = await disconnectIntegrations(siteId);
  await recordAuditEvent({ userId: decidedBy }, {
    action: 'project.demo_ended', targetType: 'site', targetId: String(siteId), tenantSiteId: siteId, tenantName: rows[0].name,
    metadata: { reason, ...removed }, success: true,
  });
  return rows[0];
}

// Renew: another full demo from today.
export async function renewDemo(siteId, { decidedBy }, now = new Date()) {
  const plan = planApproval({ type: 'demo' }, now);
  const { rows } = await query(
    `UPDATE sites SET access_state = 'demo', access_ends_at = $2, access_ended_at = NULL,
            access_decided_at = now(), access_decided_by = $3
      WHERE id = $1 AND access_state IN ('ended', 'demo') RETURNING ${COLUMNS}`, [siteId, plan.endsAt, decidedBy ?? null]);
  return rows[0] || null;
}

// What a project connected, taken away: Google (Search Console, Analytics), the GitHub repository together with the
// agent's daily pull requests (which would otherwise carry on against a repository the person no longer shares), and
// every API token.
export async function disconnectIntegrations(siteId) {
  const out = { google: false, github: false, tokens: 0 };
  const { deleteGoogleConnection, clearSiteGoogleProperties } = await import('./project-google.js');
  out.google = await deleteGoogleConnection(siteId);
  await clearSiteGoogleProperties(siteId);
  // The Google Business Profile answer goes too: a returning client is asked for it again with the rest.
  await query('UPDATE sites SET gbp_status = NULL, gbp_url = NULL, gbp_updated_at = NULL WHERE id = $1', [siteId]);
  try { (await import('../auth/project-google.js')).forgetProjectGoogleAuth(siteId); } catch { /* not loaded in this process */ }
  try { (await import('../ingest/ga4.js')).forgetGa4Client(siteId); } catch { /* not loaded in this process */ }

  const { rows } = await query('SELECT repo_owner, repo_name, auto_remediation_daily_limit FROM sites WHERE id = $1', [siteId]);
  if (rows[0]?.repo_owner || rows[0]?.repo_name) {
    const { updateSiteRepoConfig, updateSiteAutoRemediation } = await import('../db.js');
    await updateSiteAutoRemediation({ siteId, enabled: false, dailyLimit: rows[0].auto_remediation_daily_limit });
    await updateSiteRepoConfig({
      siteId, repoOwner: null, repoName: null, repoUrl: null, prTargetBranch: null, githubAppInstallationId: null,
      githubAppId: null, githubAppPrivateKeyEnvVar: null,
    });
    out.github = true;
  }
  // API tokens and the app connections made with them (Claude, ChatGPT): a token made during a demo must not outlive it.
  for (const table of ['api_tokens', 'oauth_access_tokens', 'oauth_refresh_tokens']) {
    const { rowCount } = await query(`UPDATE ${table} SET revoked_at = now() WHERE site_id = $1 AND revoked_at IS NULL`, [siteId]);
    out.tokens += rowCount || 0;
  }
  return out;
}

// The job: every demo whose time has run out. Returns the ids it ended.
export async function expireDueDemos(now = new Date()) {
  const { rows } = await query(`SELECT id FROM sites WHERE access_state = 'demo' AND access_ends_at IS NOT NULL AND access_ends_at <= $1`, [now]);
  const ended = [];
  for (const { id } of rows) {
    try { if (await endDemo(id, { reason: 'expired' })) ended.push(id); }
    catch (err) { console.error(`[access] could not end the demo for site ${id}:`, err.message); }
  }
  return ended;
}

// ───────── staff lists ─────────

// What staff decide on: projects from /get-started whose owner pressed "Request access", plus what was decided.
export async function listAccessForStaff() {
  const { rows } = await query(
    `SELECT s.id, s.name, s.website_domain, s.access_state, s.access_requested_at, s.access_ends_at, s.access_ended_at,
            s.access_decided_at, s.access_github_optional, s.created_at,
            u.email AS owner_email, u.display_name AS owner_name, o.data AS onboarding
       FROM sites s
       LEFT JOIN LATERAL (
         SELECT us.email, us.display_name FROM workspace_members m JOIN users us ON us.id = m.user_id
          WHERE m.workspace_id = s.workspace_id AND m.role = 'owner' ORDER BY m.user_id LIMIT 1
       ) u ON true
       LEFT JOIN site_onboarding o ON o.site_id = s.id
      WHERE s.access_source = 'get-started' AND s.status IS DISTINCT FROM 'soft_deleted'
        AND (s.access_state <> 'pending' OR s.access_requested_at IS NOT NULL)
      ORDER BY (s.access_state = 'pending') DESC, s.access_requested_at DESC NULLS LAST, s.id DESC`);
  return rows;
}

// Everything the person entered on /get-started, for staff: who they are, the names they chose, and the whole setup. Staff only.
export async function getSignupDetails(siteId) {
  const { rows } = await query(
    `SELECT s.id, s.name AS project_name, s.website_domain, s.access_state, s.access_requested_at, s.created_at,
            w.name AS workspace_name, u.email AS owner_email, u.display_name AS owner_name, o.data
       FROM sites s
       LEFT JOIN workspaces w ON w.id = s.workspace_id
       LEFT JOIN LATERAL (
         SELECT us.email, us.display_name FROM workspace_members m JOIN users us ON us.id = m.user_id
          WHERE m.workspace_id = s.workspace_id AND m.role = 'owner' ORDER BY m.user_id LIMIT 1
       ) u ON true
       LEFT JOIN site_onboarding o ON o.site_id = s.id
      WHERE s.id = $1`, [siteId]);
  const r = rows[0];
  if (!r) return null;
  return {
    siteId: r.id, projectName: r.project_name, workspaceName: r.workspace_name, website: r.website_domain, state: r.access_state,
    requestedAt: r.access_requested_at, createdAt: r.created_at, email: r.owner_email, name: r.owner_name, setup: r.data || null,
  };
}

// A short, safe summary of what they set up, for the approval card.
export function summarizeOnboarding(data) {
  const d = data || {};
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    brand: d.brand || null,
    category: d.profile?.category || null,
    goals: list(d.goals),
    markets: list(d.markets?.items).slice(0, 12),
    topics: list(d.topics).slice(0, 20),
    prompts: list(d.prompts).length,
    competitors: list(d.profile?.competitors).slice(0, 10),
  };
}

// ───────── coming back to /get-started ─────────

// The project to take a returning person to: the one for the website they typed (if they gave one), else the project they
// made on /get-started most recently, else any project of theirs. Only projects they belong to are ever looked at.
export async function findResumeProject(userId, { website = '' } = {}) {
  const { rows } = await query(
    `SELECT s.id, s.name, s.website_domain, s.access_state, s.access_source, s.access_requested_at, s.access_ends_at
       FROM sites s JOIN workspace_members m ON m.workspace_id = s.workspace_id
      WHERE m.user_id = $1 AND s.status IS DISTINCT FROM 'soft_deleted'
      ORDER BY (s.access_source = 'get-started') DESC, s.id DESC`, [userId]);
  if (!rows.length) return null;
  const wanted = website ? normalizeDomain(website) : null;
  if (wanted?.ok && wanted.domain) {
    const hit = rows.find((r) => { const d = normalizeDomain(r.website_domain); return d.ok && d.domain === wanted.domain; });
    return hit || null;      // they named a website that is not one of theirs: it is a new one
  }
  // No website named: only a project they made on /get-started counts as "theirs to come back to". Someone who simply owns other
  // projects (a client, or staff) has nothing to resume here.
  return rows.find((r) => r.access_source === 'get-started') || null;
}
