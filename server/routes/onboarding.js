import { Router } from 'express';
import { AuditError } from '../free-audit/fetchPage.js';
import { createRateLimiter } from '../free-audit/rateLimit.js';
import { readSiteProfile } from '../onboarding/siteProfile.js';
import { requireAuth } from './login.js';
import { isValidTimezone } from '../util/timezone.js';
import { normalizeDomain } from '../util/domain.js';
import { createWorkspace, createProject, addMember, discardNewWorkspace, setProjectGoal, validateGoal, claimHomeSiteIfNone } from '../store/workspaces.js';
import { mapGoals, cleanOnboarding, findExistingProject, saveOnboarding } from '../store/onboarding.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';

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

// The last step of /get-started: the signed-in person approves their prompts and the trial workspace is made,
// with the website as its first project, their goals set and everything they answered kept with it.
// Pressing finish again, or coming back later, returns the project that already exists.
router.post('/onboarding/complete', requireAuth, async (req, res, next) => {
  try {
    const domain = normalizeDomain(req.body?.website);
    if (!domain.ok || !domain.domain) return res.status(400).json({ error: 'Enter a website address like example.com.' });
    const data = cleanOnboarding(req.body);
    if (!data.brand) return res.status(400).json({ error: 'A brand name is required.' });

    const existing = await findExistingProject(req.userId, domain.domain);
    if (existing) {
      await saveOnboarding(existing.id, data, req.userId);
      return res.json({ ok: true, existing: true, workspaceId: existing.workspace_id, project: { id: existing.id, name: existing.name, domain: existing.website_domain } });
    }

    const timezone = isValidTimezone(data.run.timeZone) ? data.run.timeZone : undefined;
    const goals = mapGoals(data.goals);
    // A goal needs a time frame; the page does not ask for one, so a gentle default is used (editable later).
    const goalCheck = goals.length
      ? validateGoal({ goals, growth: 'steady', months: 6, customText: goals.includes('custom') ? 'Report to clients' : undefined })
      : null;

    // Same all-or-nothing shape as POST /workspaces: a failure part-way takes back what was made here.
    const workspace = await createWorkspace({ name: data.brand });
    let site = null;
    try {
      await addMember(workspace.id, req.userId, 'owner');
      site = await createProject({ workspaceId: workspace.id, name: data.brand, websiteDomain: domain.domain, timezone });
      if (goalCheck?.ok) await setProjectGoal({ siteId: site.id, ...goalCheck.goal, userId: req.userId });
      await saveOnboarding(site.id, data, req.userId);
    } catch (err) {
      await discardNewWorkspace({ workspaceId: workspace.id, siteId: site?.id ?? null })
        .catch((cleanupErr) => console.error(`[onboarding] could not discard workspace ${workspace.id} after a failed finish:`, cleanupErr.message));
      throw err;
    }

    req.workspaceId = workspace.id;
    req.workspaceRole = 'owner';
    await claimHomeSiteIfNone(req.userId, site.id);
    await recordAuditEvent(req, {
      action: 'workspace.created', targetType: 'workspace', targetId: String(workspace.id),
      metadata: { workspaceId: workspace.id, name: workspace.name, via: 'get-started' }, success: true,
    });
    await recordAuditEvent(req, {
      action: 'project.created', targetType: 'site', targetId: String(site.id), tenantSiteId: site.id, tenantName: site.name,
      metadata: { workspaceId: workspace.id, name: site.name, websiteDomain: site.website_domain, via: 'get-started' }, success: true,
    });
    res.status(201).json({ ok: true, existing: false, workspaceId: workspace.id, project: { id: site.id, name: site.name, domain: site.website_domain } });
  } catch (err) { next(err); }
});

export default router;
