import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { acceptInvitation } from '../store/user-invitations.js';
import { getUserByEmail, createUser } from '../store/users.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';

// Public — no requireAuth, parallel to the existing public
// POST /signup-requests (server/routes/login.js). An invitation is never a
// real account until this route succeeds (PLATFORM-ADMIN-DESIGN.md §E).
const router = Router();

router.post('/invitations/:token/accept', async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    // Single atomic UPDATE both validates and consumes — see
    // acceptInvitation's own comment. Covers unknown/expired/already-
    // accepted (replay) tokens with one null, not three separate checks.
    const invitation = await acceptInvitation(req.params.token);
    if (!invitation) {
      return res.status(400).json({ error: 'This invitation link is invalid, expired, or has already been used.' });
    }

    // A real race: the invited email could have become a real user another
    // way (direct staff create, a different invitation, signup approval)
    // in the time between this invitation being sent and accepted here —
    // same re-check clients.js's signup-request approve route already does
    // for the identical reason. The invitation itself is already consumed
    // above either way — not reusable even if this branch is hit.
    const existing = await getUserByEmail(invitation.email);
    if (existing) {
      return res.status(409).json({ error: `A user with email "${invitation.email}" already exists.` });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser({
      siteId: invitation.site_id,
      email: invitation.email,
      passwordHash,
      role: invitation.role,
    });

    // No session exists at this public route — attribute the audit event to
    // the account that was just created by setting req.userId/siteId
    // directly on the real request object (recordAuditEvent only ever reads
    // req.userId/req.siteId/req.ip/req.get, never req.session).
    req.userId = user.id;
    req.siteId = user.site_id;
    await recordAuditEvent(req, {
      action: 'invitation.accepted',
      targetType: 'user',
      targetId: String(user.id),
      tenantSiteId: user.site_id,
      metadata: { email: user.email, role: user.role },
      success: true,
    });

    res.status(201).json({ id: user.id, email: user.email, role: user.role, siteId: user.site_id });
  } catch (e) { next(e); }
});

export default router;
