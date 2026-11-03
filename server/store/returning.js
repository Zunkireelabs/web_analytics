import { query } from '../db.js';
import { isPlatformAdmin } from './workspaces.js';

// People who come back after everything of theirs was deleted (migration 223). The account (the email) is still in the
// database, but it belongs to no workspace and no project: a SuperRank person approves them before a code is sent.

export const RETURN_WAIT_MESSAGE = 'Welcome back. Your earlier workspace was removed, so a SuperRank team member needs to approve you before we send a sign-in code. We have told the team. As soon as they approve, we email you a new code. This is usually done within one working day.';

const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// What we know about why the account is empty, in a line staff can read.
async function describeHistory(user) {
  const { rows } = await query(
    `SELECT name, deleted_at FROM workspaces WHERE deleted_at IS NOT NULL AND deleted_members @> $1::jsonb ORDER BY deleted_at DESC`,
    [JSON.stringify([{ userId: user.id }])]);
  if (rows.length) return `All their projects were deleted: ${rows.map((w) => `workspace "${w.name}" was removed on ${fmtDate(w.deleted_at)}`).join('; ')}.`;
  return 'Their project was deleted, and they no longer belong to any workspace.';
}

// True when this account must be approved again before it gets a code. Never for staff, never for a brand-new account (it has
// no history), never while they still belong to something live, never once staff approved and it has not been used yet.
export async function needsReturnApproval(user, { companySiteId = 0 } = {}) {
  if (!user || isPlatformAdmin(user, companySiteId)) return null;
  const live = await query(
    `SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 AND w.deleted_at IS NULL
     UNION ALL SELECT 1 FROM project_members pm JOIN sites s ON s.id = pm.site_id WHERE pm.user_id = $1 AND s.status IS DISTINCT FROM 'soft_deleted' LIMIT 1`, [user.id]);
  if (live.rows.length) return null;
  const hist = await query(`SELECT 1 FROM workspaces WHERE deleted_members @> $1::jsonb LIMIT 1`, [JSON.stringify([{ userId: user.id }])]);
  let dangling = false;
  if (user.site_id != null) {
    const s = await query(`SELECT status FROM sites WHERE id = $1`, [user.site_id]);
    dangling = (s.rows[0]?.status ?? 'soft_deleted') === 'soft_deleted';
  }
  if (!hist.rows.length && !dangling) return null;
  const ok = await query(`SELECT 1 FROM return_requests WHERE user_id = $1 AND status = 'approved' AND used_at IS NULL LIMIT 1`, [user.id]);
  if (ok.rows.length) return null;
  return { reason: await describeHistory(user) };
}

// One open request per person. created is true only for the call that made it, so staff are emailed once.
export async function openReturnRequest(user, reason) {
  const open = await query(`SELECT id FROM return_requests WHERE user_id = $1 AND status = 'pending' LIMIT 1`, [user.id]);
  if (open.rows[0]) return { id: open.rows[0].id, created: false };
  const { rows } = await query(`INSERT INTO return_requests (user_id, email, reason) VALUES ($1, $2, $3) RETURNING id`, [user.id, user.email, reason]);
  return { id: rows[0].id, created: true };
}

// Staff see, for each person: when the account was first made, and what was removed (the workspace and the projects in it, and when).
// A person whose workspace history was not recorded still shows the project their account was last pointed at.
export async function listReturnRequests() {
  const { rows } = await query(
    `SELECT r.id, r.user_id, r.email, r.reason, r.status, r.created_at, r.decided_at, u.display_name, u.created_at AS account_created_at
       FROM return_requests r JOIN users u ON u.id = r.user_id
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 40`);
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const removed = new Map();
  const lastProject = new Map();
  if (ids.length) {
    const gone = await query(
      `SELECT u.id AS user_id, w.name AS workspace, w.deleted_at,
              COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM sites s WHERE s.workspace_id = w.id), '{}') AS projects
         FROM unnest($1::int[]) AS u(id)
         JOIN workspaces w ON w.deleted_at IS NOT NULL AND w.deleted_members @> jsonb_build_array(jsonb_build_object('userId', u.id))
        ORDER BY w.deleted_at DESC`, [ids]);
    for (const g of gone.rows) removed.set(g.user_id, [...(removed.get(g.user_id) || []), { workspace: g.workspace, deletedAt: g.deleted_at, projects: g.projects || [] }]);
    const last = await query(`SELECT u.id AS user_id, s.name FROM users u JOIN sites s ON s.id = u.site_id WHERE u.id = ANY($1::int[])`, [ids]);
    for (const l of last.rows) lastProject.set(l.user_id, l.name);
  }
  return rows.map((r) => ({
    id: r.id, email: r.email, name: r.display_name || null, reason: r.reason, status: r.status, requestedAt: r.created_at, decidedAt: r.decided_at,
    accountCreatedAt: r.account_created_at, removed: removed.get(r.user_id) || [], lastProject: lastProject.get(r.user_id) || null,
  }));
}

export async function decideReturnRequest(id, status, by) {
  const { rows } = await query(
    `UPDATE return_requests SET status = $2, decided_at = now(), decided_by = $3 WHERE id = $1 AND status = 'pending' RETURNING id, user_id, email`,
    [id, status, by ?? null]);
  return rows[0] || null;
}

// A sign-in succeeded: an approval is for one return, so it is spent now.
export async function markReturnUsed(userId) {
  await query(`UPDATE return_requests SET used_at = now() WHERE user_id = $1 AND status = 'approved' AND used_at IS NULL`, [userId]);
}
