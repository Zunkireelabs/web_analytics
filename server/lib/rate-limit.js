import { query } from '../db.js';

// Fixed-window counters kept in Postgres (migration 209), so a limit holds across every app instance.
// A route is limited twice over — per IP and per normalised address — so neither one noisy IP
// guessing many accounts nor many IPs hammering one account gets through.

// Counts one hit and says whether it is within the limit. Fails OPEN on a database error: a limiter
// that cannot reach its store must not lock every customer out of signing in.
export async function hit(key, limit, windowSec, { run = query } = {}) {
  try {
    const { rows } = await run(
      `INSERT INTO rate_limits (key, count, window_start) VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start < now() - ($2 || ' seconds')::interval THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start < now() - ($2 || ' seconds')::interval THEN now() ELSE rate_limits.window_start END
       RETURNING count, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_start + ($2 || ' seconds')::interval - now()))))::int AS retry_after`,
      [key, String(windowSec)],
    );
    const { count, retry_after: retryAfter } = rows[0];
    if (Math.random() < 0.01) run(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`).catch(() => {});
    return { allowed: count <= limit, retryAfter };
  } catch (err) {
    console.error('[rate-limit] store unavailable, allowing the request:', err.message);
    return { allowed: true, retryAfter: 0 };
  }
}

const normEmail = (v) => String(v || '').trim().toLowerCase();

// Rules per POST path: [limit, windowSec] for the caller's IP, and for the address in the body (when it has one).
export const AUTH_LIMITS = {
  '/login': { ip: [20, 900], email: [8, 900] },
  '/login/code/send': { ip: [10, 3600], email: [5, 3600] },
  '/login/code/verify': { ip: [30, 900], email: [10, 900] },
  '/signup-requests': { ip: [5, 3600], email: [3, 3600], emailField: 'contactEmail' },
  '/signup/activate': { ip: [20, 900] },
  '/signup/verify': { ip: [20, 900] },
  '/contact-requests': { ip: [5, 3600], email: [3, 3600], emailField: 'contactEmail' },
};

export function authRateLimit({ limits = AUTH_LIMITS, hitFn = hit } = {}) {
  return async function authRateLimitMiddleware(req, res, next) {
    // Express matches routes case-insensitively and ignores a trailing slash, so the lookup must too, or
    // `POST /login/` or `/LOGIN` would reach the route and skip its limit.
    const path = String(req.path || '').toLowerCase().replace(/\/+$/, '') || '/';
    const rule = req.method === 'POST' ? limits[path] : null;
    if (!rule) return next();
    try {
      const checks = [hitFn(`ip:${path}:${req.ip}`, ...rule.ip)];
      const email = rule.email ? normEmail(req.body?.[rule.emailField || 'email']) : '';
      if (email) checks.push(hitFn(`em:${path}:${email}`, ...rule.email));
      const results = await Promise.all(checks);
      const blocked = results.find((r) => !r.allowed);
      if (blocked) {
        res.set('Retry-After', String(blocked.retryAfter));
        const mins = Math.max(1, Math.ceil(blocked.retryAfter / 60));
        // The same answer whatever the address is, so it says nothing about which accounts exist.
        return res.status(429).json({ error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, code: 'RATE_LIMITED' });
      }
    } catch (err) {
      console.error('[rate-limit] check failed, allowing the request:', err.message);
    }
    return next();
  };
}
