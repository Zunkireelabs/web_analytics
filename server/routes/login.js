import { Router } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';

// Simple shared-password login. One password (DASHBOARD_PASSWORD) for the whole
// team, stored in a signed session cookie. Good enough for an internal dashboard.
const router = Router();

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!process.env.DASHBOARD_PASSWORD) {
    return res.status(500).json({ error: 'DASHBOARD_PASSWORD not configured on server.' });
  }
  const safe = (a, b) => {
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb);
  };
  if (password && safe(password, process.env.DASHBOARD_PASSWORD)) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Wrong password.' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  res.json({ authed: !!req.session?.authed });
});

// Middleware to protect data routes.
export function requireAuth(req, res, next) {
  if (req.session?.authed) return next();
  return res.status(401).json({ error: 'Not authenticated.' });
}

export default router;
