import { query } from '../../db.js';
import { getUserById } from '../users.js';

// Lives under server/store/admin/, physically separate from tenant-scoped
// store functions (server/store/read.js, server/store/api-tokens.js), per
// PLATFORM-ADMIN-DESIGN.md §G.2 — this file has no implicit tenant filter
// (it writes any tenant_site_id a caller passes), so the import path itself
// signals "this bypasses tenant isolation."
//
// Phase 2 scope (§K): passive, wired to existing mutating handlers only —
// no new actions, no new UI. `recordAuditEvent` is a plain async function,
// not middleware — called explicitly at the end of a mutating handler,
// after its write has already succeeded (§G.1: "never called from a GET/
// read handler").

const PLATFORM_ROLES = new Set(['platform_admin']);

// actor_role is a snapshot "AT THE TIME of the action" (§G.3), not a live
// lookup — but the only way to take that snapshot is a live read of the
// user row *right now*, at write time, which is what this does. It doesn't
// trust req.userRole from an upstream role-gate middleware: mcp-tokens.js's
// revoke handler (Phase 2's other wiring target) is only requireAuth-gated,
// no role middleware runs before it, so req.userRole is never set there.
async function resolveActor(req) {
  const user = await getUserById(req.userId);
  if (!user) return { actorType: 'system', actorId: null, actorRole: null, actorEmail: null };
  return {
    actorType: PLATFORM_ROLES.has(user.role) ? 'platform_user' : 'tenant_user',
    actorId: user.id,
    actorRole: user.role,
    actorEmail: user.email,
  };
}

// metadata must already be an allowlisted plain object built by the caller
// — never req.body/req.query passed through wholesale, and never a
// password, reset token, invitation token, bearer token, or other secret
// value (§G.1). This function does not sanitize metadata itself; each call
// site is responsible for only including fields it has deliberately chosen.
//
// Never throws: an audit-log write failing must not take down the mutating
// action it's describing (same best-effort, swallow-and-log convention as
// job.js's sendDailyEmail / login.js's contact-lead email).
export async function recordAuditEvent(req, {
  action,
  targetType = null,
  targetId = null,
  tenantSiteId = null,
  tenantName = null,
  metadata = null,
  success,
  errorMessage = null,
}) {
  try {
    const actor = await resolveActor(req);
    await query(
      `INSERT INTO audit_log (
         actor_type, actor_id, actor_role, actor_site_id, actor_email,
         tenant_site_id, tenant_name, ip_address, user_agent,
         action, target_type, target_id, metadata, success, error_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        actor.actorType, actor.actorId, actor.actorRole, req.siteId ?? null, actor.actorEmail,
        tenantSiteId, tenantName, req.ip ?? null, req.get?.('user-agent') ?? null,
        action, targetType, targetId, metadata ? JSON.stringify(metadata) : null, success, errorMessage,
      ]
    );
  } catch (err) {
    console.error(`[audit-log] failed to record "${action}":`, err.message);
  }
}

// Read side (PLATFORM-ADMIN-DESIGN.md §F.7, §K) — filterable by the same
// axes the table is indexed on (see migration 065): tenant, actor type,
// action, and a created_at range. All filters are optional/ANDed; omitting
// one just widens the result set rather than requiring every caller to
// pass every field.
export async function listAuditLog({ tenantSiteId, actorType, action, since, until, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  let i = 1;
  if (tenantSiteId) { conditions.push(`tenant_site_id = $${i++}`); params.push(tenantSiteId); }
  if (actorType) { conditions.push(`actor_type = $${i++}`); params.push(actorType); }
  if (action) { conditions.push(`action = $${i++}`); params.push(action); }
  if (since) { conditions.push(`created_at >= $${i++}`); params.push(since); }
  if (until) { conditions.push(`created_at <= $${i++}`); params.push(until); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT id, actor_type, actor_id, actor_role, actor_site_id, actor_email,
            tenant_site_id, tenant_name, ip_address, user_agent, action,
            target_type, target_id, metadata, success, error_message, created_at
       FROM audit_log
       ${where}
      ORDER BY created_at DESC
      LIMIT $${i++} OFFSET $${i++}`,
    params
  );
  return rows;
}
