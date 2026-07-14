import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getUserByEmail } from '../store/users.js';
import { createSignupRequest } from '../store/signup-requests.js';

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
