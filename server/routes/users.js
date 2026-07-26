import { Router } from 'express';
import { requireAuth, requirePlatformRole, requireTenantRole, PLATFORM_ROLE_RANK, TENANT_ROLE_RANK } from './login.js';
import { getUserById, getUserByEmail, listUsersForSite, updateUserRole, disableUser } from '../store/users.js';
import { listAllUsers } from '../store/admin/users.js';
import { createInvitation } from '../store/user-invitations.js';
import { sendInvitationEmail } from '../report/email.js';
import { getSiteById } from '../store/read.js';
import { revokeOauthAccessTokensForUser } from '../store/oauth-access-tokens.js';
import { revokeOauthRefreshTokensForUser } from '../store/oauth-refresh-tokens.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';

// User/team management (PLATFORM-ADMIN-DESIGN.md §E, §G.2, §K Phase 4).
// Deliberately one file with two path prefixes, not two files — the two
// route groups below share the same underlying store functions and differ
// only in *how narrowly* each derives its own allowed site_id/role set from
// the acting caller (§E's "server-derived, never client-supplied" rule),
// which is exactly the kind of thing that belongs side by side for anyone
// auditing that the derivation is actually correct on both paths.
//
// "Invite" never creates a users row directly — it creates a user_invitations
// row and emails a link; the real row only exists after
// server/routes/user-invitations.js's public accept route consumes it.
// "Disable" (DELETE) is a soft status flip, never a hard DELETE — hard
// user-delete is explicitly deferred, not scoped for this phase (§E).
const router = Router();

const ALL_ROLES = new Set([...Object.keys(PLATFORM_ROLE_RANK), ...Object.keys(TENANT_ROLE_RANK)]);

function originOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

async function sendInvitation({ req, siteId, siteName, email, role, res }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const existingUser = await getUserByEmail(normalizedEmail);
  if (existingUser) {
    res.status(409).json({ error: `A user with email "${normalizedEmail}" already exists.` });
    return null;
  }

  const invitation = await createInvitation({ siteId, email: normalizedEmail, role, invitedBy: req.userId });
  const acceptUrl = `${originOf(req)}/accept-invite?token=${invitation.token}`;
  try {
    await sendInvitationEmail({ to: normalizedEmail, siteName, role, acceptUrl });
  } catch (err) {
    console.error('[users] invitation email failed:', err.message);
  }

  await recordAuditEvent(req, {
    action: 'user.invited',
    targetType: 'user_invitation',
    targetId: String(invitation.id),
    tenantSiteId: siteId,
    tenantName: siteName,
    metadata: { email: normalizedEmail, role },
    success: true,
  });

  res.status(201).json({ id: invitation.id, email: normalizedEmail, role, siteId, expiresAt: invitation.expires_at });
  return invitation;
}

async function disableAndRevoke(req, res, { target, tenantSiteId, tenantName }) {
  const disabled = await disableUser(target.id);
  if (!disabled) {
    res.status(409).json({ error: `User is not currently active (status: ${target.status}).` });
    return;
  }

  // §E: disabling a user actively revokes outstanding OAuth grants rather
  // than leaving them live until natural expiry — see the store functions'
  // own comments for why this can't just be left to oauth_access_tokens/
  // oauth_refresh_tokens.user_id's ON DELETE CASCADE (that only fires on a
  // hard users DELETE, which this isn't).
  await Promise.all([
    revokeOauthAccessTokensForUser(target.id),
    revokeOauthRefreshTokensForUser(target.id),
  ]);

  await recordAuditEvent(req, {
    action: 'user.disabled',
    targetType: 'user',
    targetId: String(target.id),
    tenantSiteId,
    tenantName,
    metadata: { targetEmail: target.email },
    success: true,
  });

  res.json({ id: disabled.id, status: disabled.status });
}

// ── Platform-wide (/internal/users) ─────────────────────────────────────
// Every route here can target ANY tenant, including COMPANY_SITE_ID, and
// the invite/role-change routes are the only path permitted to grant the
// platform tier (platform_admin) — exactly the asymmetry §E's CRITICAL
// finding required be explicit, not assumed.

router.get('/internal/users', requireAuth, requirePlatformRole('platform_admin'), async (req, res, next) => {
  try {
    res.json(await listAllUsers());
  } catch (e) { next(e); }
});

router.post('/internal/users', requireAuth, requirePlatformRole('platform_admin'), async (req, res, next) => {
  try {
    const { email, role, siteId: rawSiteId } = req.body || {};
    const siteId = Number(rawSiteId);
    if (!email || !String(email).trim()) return res.status(400).json({ error: 'email is required.' });
    if (!ALL_ROLES.has(role)) return res.status(400).json({ error: `role must be one of: ${[...ALL_ROLES].join(', ')}.` });
    if (!siteId) return res.status(400).json({ error: 'siteId is required.' });

    const site = await getSiteById(siteId);
    if (!site) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    await sendInvitation({ req, siteId, siteName: site.name, email, role, res });
  } catch (e) { next(e); }
});

router.patch('/internal/users/:id', requireAuth, requirePlatformRole('platform_admin'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const { role } = req.body || {};
    if (!ALL_ROLES.has(role)) return res.status(400).json({ error: `role must be one of: ${[...ALL_ROLES].join(', ')}.` });

    const target = await getUserById(targetId);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const updated = await updateUserRole(targetId, role);

    await recordAuditEvent(req, {
      action: 'user.role_changed',
      targetType: 'user',
      targetId: String(targetId),
      tenantSiteId: target.site_id,
      metadata: { targetEmail: target.email, previousRole: target.role, newRole: role },
      success: true,
    });

    res.json({ id: updated.id, role: updated.role });
  } catch (e) { next(e); }
});

router.delete('/internal/users/:id', requireAuth, requirePlatformRole('platform_admin'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const target = await getUserById(targetId);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    await disableAndRevoke(req, res, { target, tenantSiteId: target.site_id, tenantName: null });
  } catch (e) { next(e); }
});

// ── Own-tenant (/users) ──────────────────────────────────────────────────
// site_id is always req.siteId (from the session, via requireAuth) — never
// a param, never body-supplied — and role is restricted to the three
// tenant-tier values. This is the ONLY invariant that makes it safe for a
// Tenant Admin to hold this capability at all: they can never reach another
// tenant's users or grant a platform tier, by construction, not by convention.

router.get('/users', requireAuth, async (req, res, next) => {
  try {
    res.json(await listUsersForSite(req.siteId));
  } catch (e) { next(e); }
});

router.post('/users', requireAuth, requireTenantRole('tenant_admin'), async (req, res, next) => {
  try {
    const { email, role } = req.body || {};
    if (!email || !String(email).trim()) return res.status(400).json({ error: 'email is required.' });
    if (!Object.prototype.hasOwnProperty.call(TENANT_ROLE_RANK, role)) {
      return res.status(400).json({ error: `role must be one of: ${Object.keys(TENANT_ROLE_RANK).join(', ')}.` });
    }

    const site = await getSiteById(req.siteId);
    await sendInvitation({ req, siteId: req.siteId, siteName: site.name, email, role, res });
  } catch (e) { next(e); }
});

router.patch('/users/:id', requireAuth, requireTenantRole('tenant_admin'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const { role } = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(TENANT_ROLE_RANK, role)) {
      return res.status(400).json({ error: `role must be one of: ${Object.keys(TENANT_ROLE_RANK).join(', ')}.` });
    }

    const target = await getUserById(targetId);
    // 404, not 403, for a user id outside the caller's own tenant — same
    // "don't confirm cross-tenant existence" posture as requirePlatformRole,
    // just applied one level down (tenant boundary, not platform boundary).
    if (!target || target.site_id !== req.siteId) return res.status(404).json({ error: 'User not found.' });

    const updated = await updateUserRole(targetId, role);

    await recordAuditEvent(req, {
      action: 'user.role_changed',
      targetType: 'user',
      targetId: String(targetId),
      tenantSiteId: req.siteId,
      metadata: { targetEmail: target.email, previousRole: target.role, newRole: role },
      success: true,
    });

    res.json({ id: updated.id, role: updated.role });
  } catch (e) { next(e); }
});

router.delete('/users/:id', requireAuth, requireTenantRole('tenant_admin'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const target = await getUserById(targetId);
    if (!target || target.site_id !== req.siteId) return res.status(404).json({ error: 'User not found.' });

    await disableAndRevoke(req, res, { target, tenantSiteId: req.siteId, tenantName: null });
  } catch (e) { next(e); }
});

export default router;
