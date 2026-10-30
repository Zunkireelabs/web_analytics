import { Router } from 'express';
import { AuditError } from '../free-audit/fetchPage.js';
import { createRateLimiter } from '../free-audit/rateLimit.js';
import { readSiteProfile } from '../onboarding/siteProfile.js';

// Public (no session yet): the get-started page calls this as soon as a visitor types their
// site, to pre-fill the brand profile. It fetches third-party sites and makes one model call,
// so it is rate limited per IP and capped on concurrency, like the free audit.
const router = Router();
const take = createRateLimiter({ windowMs: 10 * 60 * 1000, max: Number(process.env.ONBOARDING_SITE_RATE_MAX) || 6 });
const MAX_CONCURRENT = 4;
let active = 0;
const STATUS_BY_CODE = { invalid_url: 400, not_html: 422, fetch_failed: 502, timeout: 504 };

router.post('/onboarding/site', async (req, res, next) => {
  try {
    const website = req.body?.website;
    const retryAfter = take(req.ip);
    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Please try again in a few minutes.' });
    }
    if (active >= MAX_CONCURRENT) return res.status(503).json({ error: 'busy', message: 'Busy right now. Please try again in a moment.' });
    active++;
    try {
      const profile = await readSiteProfile(website);
      res.json({ profile });
    } finally {
      active--;
    }
  } catch (err) {
    if (err instanceof AuditError) return res.status(STATUS_BY_CODE[err.code] || 500).json({ error: err.code, message: err.message });
    next(err);
  }
});

export default router;
