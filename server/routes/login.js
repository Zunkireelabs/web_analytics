import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getUserByEmail, getUserById, updateUserPassword, getUserStatus } from '../store/users.js';
import { createSignupRequest } from '../store/signup-requests.js';
import { createContactRequest } from '../store/contact-requests.js';
import { sendContactLeadEmail, sendPasswordResetEmail } from '../report/email.js';
import { getSiteStatus } from '../store/read.js';
import { createPasswordReset, consumePasswordReset } from '../store/password-resets.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';

// Per-client login. One user account per site (see
// server/migrations/011_users_and_site_profile.sql) — provisioned via
// `npm run create-client` or staff approval of a real signup request (see
// POST /signup-requests below), never immediately self-serve.
const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(401).json({ error: 'Email and password are required.' });
    }
    const user = await getUserByEmail(String(email).trim().toLowerCase());
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password.' });
    req.session.userId = user.id;
    req.session.siteId = user.site_id;
    return res.json({ ok: true });
  } catch (e) { next(e); }
});

// Public — no requireAuth, same as /login above. Never creates a real
// account directly: only a pending signup_requests row, reviewed by staff
// on /clients (see routes/clients.js's approve/reject routes) before a real
// sites/users row exists. `honeypot` is a hidden form field real users
// never fill in — a bot that fills every field gets a fake 200 with no row
// written, a lightweight zero-dependency anti-spam measure (no CAPTCHA/
// third-party service needed for this low-traffic B2B form).
router.post('/signup-requests', async (req, res, next) => {
  try {
    const { companyName, websiteDomain, contactEmail, password, message, honeypot } = req.body || {};
    if (honeypot) return res.status(200).json({ ok: true }); // silently pretend success to the bot

    if (!companyName || !String(companyName).trim()) return res.status(400).json({ error: 'companyName is required.' });
    if (!contactEmail || !password) return res.status(400).json({ error: 'contactEmail and password are required.' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const normalizedEmail = String(contactEmail).trim().toLowerCase();
    const existing = await getUserByEmail(normalizedEmail);
    if (existing) return res.status(409).json({ error: `A user with email "${normalizedEmail}" already exists.` });

    const passwordHash = await bcrypt.hash(password, 10);
    const request = await createSignupRequest({
      companyName: String(companyName).trim(),
      websiteDomain: websiteDomain ? String(websiteDomain).trim() : null,
      contactEmail: normalizedEmail,
      passwordHash,
      message: message ? String(message).trim() : null,
    });
    res.status(201).json({ id: request.id, status: request.status });
  } catch (e) { next(e); }
});

// Public — same no-auth, honeypot-anti-spam treatment as POST
// /signup-requests above, but for a lightweight "get in touch" lead: no
// password, never becomes a real account. Only ever creates a
// contact_requests row — the sales team is notified by email (below), not
// through a staff review page in this app.
router.post('/contact-requests', async (req, res, next) => {
  try {
    const { companyName, websiteDomain, contactEmail, message, honeypot } = req.body || {};
    if (honeypot) return res.status(200).json({ ok: true }); // silently pretend success to the bot

    if (!companyName || !String(companyName).trim()) return res.status(400).json({ error: 'companyName is required.' });
    if (!contactEmail || !String(contactEmail).trim()) return res.status(400).json({ error: 'contactEmail is required.' });

    const normalizedCompanyName = String(companyName).trim();
    const normalizedWebsiteDomain = websiteDomain ? String(websiteDomain).trim() : null;
    const normalizedContactEmail = String(contactEmail).trim().toLowerCase();
    const normalizedMessage = message ? String(message).trim() : null;

    const request = await createContactRequest({
      companyName: normalizedCompanyName,
      websiteDomain: normalizedWebsiteDomain,
      contactEmail: normalizedContactEmail,
      message: normalizedMessage,
    });

    // Best-effort — same swallow-and-log pattern job.js uses around
    // sendDailyEmail — an SMTP hiccup should never turn a successful lead
    // submission into an error response for the visitor.
    try {
      await sendContactLeadEmail({
        companyName: normalizedCompanyName,
        websiteDomain: normalizedWebsiteDomain,
        contactEmail: normalizedContactEmail,
        message: normalizedMessage,
      });
    } catch (err) {
      console.error('[contact-requests] lead notification email failed:', err.message);
    }

    res.status(201).json({ id: request.id, status: request.status });
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Every account can change its own password — same bcrypt convention as
// /signup-requests above (10 rounds, 8-char minimum). Requires the current
// password so an already-open, unattended session can't be used to silently
// lock the real owner out. Leaves the session intact — this codebase has no
// multi-session tracking to invalidate, so there's nothing else to do here.
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required.' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const user = await getUserById(req.userId);
    const valid = user && (await bcrypt.compare(currentPassword, user.password_hash));
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await updateUserPassword(req.userId, passwordHash);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Confirms the current session's own password without changing anything —
// used as a speed bump before a sensitive action (minting an automation/
// admin-tier MCP token, see McpTokensCard.jsx). Not a hard access-control
// boundary: the same session can already perform the action it's gating
// directly via the API. Same bcrypt.compare convention as /change-password.
router.post('/verify-password', requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password is required.' });
    const user = await getUserById(req.userId);
    const valid = user && (await bcrypt.compare(password, user.password_hash));
    if (!valid) return res.status(401).json({ error: 'Password is incorrect.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Absolute link base for the emailed accept/reset links below — same
// derivation as server/routes/oauth.js's own originOf, duplicated rather
// than imported since it's a one-line request-derived value, not shared
// state.
function originOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// Admin-triggered password reset (PLATFORM-ADMIN-DESIGN.md §E) — "within
// the actor's own scope": a Tenant Admin may only reset a user in their own
// site_id; a Platform Admin may reset anyone. This is a same-handler check,
// not a route-level role gate, because the legal target set depends on
// *whose* tenant the target belongs to relative to the actor — exactly the
// kind of thing requirePlatformRole/requireTenantRole alone can't express.
router.post('/users/:id/reset-password', requireAuth, async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const [actor, target] = await Promise.all([getUserById(req.userId), getUserById(targetId)]);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const isPlatformAdmin = actor?.role === 'platform_admin';
    const isOwnTenantAdmin = actor?.role === 'tenant_admin' && actor.site_id === target.site_id;
    if (!isPlatformAdmin && !isOwnTenantAdmin) {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    const reset = await createPasswordReset(target.id);
    const resetUrl = `${originOf(req)}/reset-password?token=${reset.token}`;
    try {
      await sendPasswordResetEmail({ to: target.email, resetUrl });
    } catch (err) {
      console.error('[reset-password] email failed:', err.message);
    }

    await recordAuditEvent(req, {
      action: 'user.password_reset_requested',
      targetType: 'user',
      targetId: String(target.id),
      tenantSiteId: target.site_id,
      metadata: { targetEmail: target.email },
      success: true,
    });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Public completion half — parallels the accept-invitation route's atomic
// single-use consumption exactly (server/routes/user-invitations.js).
router.post('/password-reset/:token', async (req, res, next) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const claimed = await consumePasswordReset(req.params.token);
    if (!claimed) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await updateUserPassword(claimed.user_id, passwordHash);

    // No session exists at this public route — attribute the audit event to
    // the account whose password just changed by setting req.userId/siteId
    // directly on the real request object before the call (recordAuditEvent
    // only ever reads req.userId/req.siteId/req.ip/req.get, never
    // req.session, so this is safe and keeps req.ip/req.get intact, unlike
    // spreading req into a plain object would).
    const user = await getUserById(claimed.user_id);
    req.userId = claimed.user_id;
    req.siteId = user?.site_id ?? null;
    await recordAuditEvent(req, {
      action: 'user.password_reset_completed',
      targetType: 'user',
      targetId: String(claimed.user_id),
      tenantSiteId: user?.site_id ?? null,
      success: true,
    });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/me', async (req, res, next) => {
  try {
    const authed = !!(req.session?.userId && req.session?.siteId);
    if (!authed) return res.json({ authed: false, isInternal: false });
    const user = await getUserById(req.session.userId);
    res.json({
      authed: true,
      isInternal: isInternalSite(req.session.siteId),
      role: user?.role || null,
      email: user?.email || null,
    });
  } catch (e) { next(e); }
});

// The AI Growth Platform (server/agents, server/routes/action-center.js) is
// internal-only — never part of the client-facing product (see
// master-product skill, Part 2). This is the single place that decides
// which site counts as "internal," so every gate stays consistent.
function isInternalSite(siteId) {
  const companySiteId = Number(process.env.COMPANY_SITE_ID);
  return Boolean(companySiteId) && siteId === companySiteId;
}

// Middleware to protect data routes. Also attaches the session's own site
// id so downstream routes never need to (and can't) trust a
// client-supplied `site` param.
//
// Suspension check (PLATFORM-ADMIN-DESIGN.md §D, §I) — one of three
// independent auth lanes that must all enforce sites.status === 'active'
// (the other two: requireMcpToken in mcp/auth.js, and oauth-provider.js's
// token issuance/refresh, neither of which goes through this function at
// all). 403, not 401: the session itself is valid — this caller really did
// authenticate as this user — access is what's being withheld, and unlike
// requirePlatformRole's "can't detect the route" posture, a suspended
// tenant's own users already know they're a client of a real tenant, so
// there's no route-existence secret to protect by hiding behind a 401/404.
//
// Disabled-user check (§E, Phase 4) — same mechanism, same "next request
// after the admin action" bounded-staleness posture, added alongside the
// site check rather than as a separate later pass over this function. Run
// in parallel: independent lookups on independent tables, no reason to
// serialize them.
export async function requireAuth(req, res, next) {
  if (req.session?.userId && req.session?.siteId) {
    req.userId = req.session.userId;
    req.siteId = req.session.siteId;
    try {
      const [siteStatus, userStatus] = await Promise.all([
        getSiteStatus(req.siteId),
        getUserStatus(req.userId),
      ]);
      if (siteStatus !== 'active') {
        return res.status(403).json({ error: 'This account is suspended.' });
      }
      if (userStatus !== 'active') {
        return res.status(403).json({ error: 'This user has been disabled.' });
      }
    } catch (e) { return next(e); }
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated.' });
}

// Platform Administration role dimension (PLATFORM-ADMIN-DESIGN.md §C.1,
// §G.1) — independent of MCP token permission_level (api_tokens.permission_
// level, oauth_access_tokens); no code path may read one to infer the
// other (§C.3). Exported so server/routes/users.js's invite/role-change
// handlers can validate a requested role against the same two canonical
// sets used for access-control here, instead of a second hand-maintained
// list drifting out of sync with these.
export const PLATFORM_ROLE_RANK = { platform_admin: 1 };
export const TENANT_ROLE_RANK = { tenant_member: 1, tenant_admin: 2 };

// Replaces requireInternalSite as the floor for every staff-only router
// (§G.1's pseudocode). Still 404s, never 403, for both failure modes — a
// client site can't tell the route exists, and neither can an internal-site
// user whose role falls short, the same "can't detect the route" posture
// requireInternalSite already had. Must run after requireAuth.
//
// Fetches the acting user's role fresh on every call rather than caching it
// in the session alongside userId/siteId: role is exactly the kind of thing
// a later phase's role-change action (§E) needs to take effect on the
// user's very next request, not after they happen to log in again.
export function requirePlatformRole(minRole) {
  const minRank = PLATFORM_ROLE_RANK[minRole];
  if (!minRank) throw new Error(`requirePlatformRole: unknown role "${minRole}"`);
  return async function (req, res, next) {
    try {
      if (!isInternalSite(req.siteId)) return res.status(404).json({ error: 'Not found.' });
      const user = await getUserById(req.userId);
      const rank = PLATFORM_ROLE_RANK[user?.role];
      if (!rank || rank < minRank) return res.status(404).json({ error: 'Not found.' });
      req.userRole = user.role;
      next();
    } catch (e) { next(e); }
  };
}

// Tenant-tier equivalent, for tenant-admin-only actions inside the
// client-facing app (Phase 4: editing own tenant settings, inviting a
// teammate). Reads req.siteId from the session (set by requireAuth), never
// a request param, so a tenant-scoped route stays exactly as isolated as it
// is today. 403s rather than 404s: unlike the platform console, a tenant
// user already knows the feature exists (e.g. sees an "Invite teammate"
// button) — there's no route-existence secret to protect here, just an
// ordinary same-tenant permission floor. Not called from anywhere yet —
// introduced now per §K's Phase 1 scope so Phase 4 isn't blocked on it.
export function requireTenantRole(minRole) {
  const minRank = TENANT_ROLE_RANK[minRole];
  if (!minRank) throw new Error(`requireTenantRole: unknown role "${minRole}"`);
  return async function (req, res, next) {
    try {
      const user = await getUserById(req.userId);
      const rank = TENANT_ROLE_RANK[user?.role];
      if (!rank || rank < minRank) return res.status(403).json({ error: 'Forbidden.' });
      req.userRole = user.role;
      next();
    } catch (e) { next(e); }
  };
}

export default router;
