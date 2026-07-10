import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getUserByEmail } from '../store/users.js';

// Per-client login. One user account per site (see
// server/migrations/011_users_and_site_profile.sql) — provisioned via
// `npm run create-client`, not self-serve signup.
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

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  const authed = !!(req.session?.userId && req.session?.siteId);
  res.json({ authed, isInternal: authed && isInternalSite(req.session.siteId) });
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
export function requireAuth(req, res, next) {
  if (req.session?.userId && req.session?.siteId) {
    req.userId = req.session.userId;
    req.siteId = req.session.siteId;
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated.' });
}

// Restricts a route to the internal company site only. 404s (not 403) so a
// client site can't even tell the route exists. Must run after requireAuth.
export function requireInternalSite(req, res, next) {
  if (isInternalSite(req.siteId)) return next();
  return res.status(404).json({ error: 'Not found.' });
}

export default router;
