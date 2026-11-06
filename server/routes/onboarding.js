import { Router } from 'express';
import { AuditError } from '../free-audit/fetchPage.js';
import { createRateLimiter } from '../free-audit/rateLimit.js';
import { readSiteProfile } from '../onboarding/siteProfile.js';
import { requireAuth } from './login.js';
import { getUserById } from '../store/users.js';
import { isValidTimezone } from '../util/timezone.js';
import { normalizeDomain } from '../util/domain.js';
import { createWorkspace, createProject, addMember, discardNewWorkspace, setProjectGoal, validateGoal, claimHomeSiteIfNone } from '../store/workspaces.js';
import { mapGoals, cleanOnboarding, findExistingProject, saveOnboarding, cleanDraft, saveDraft, getDraft, deleteDraft, findAddTarget, discardNewProject } from '../store/onboarding.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';
import { markPending, summarizeOnboarding, findResumeProject, getSiteAccess, describeAccess } from '../store/access.js';
import { sendAccessRequestStaffNotice, sendAccessReceivedEmail } from '../report/email.js';
import { appOrigin } from './lib/app-url.js';
import { resumeContext } from '../store/signup-recovery.js';
import { endedBeyondGrace } from '../lib/ended-grace.js';

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

// Coming back to /get-started: where does this person stand? 'new' (nothing yet, carry on), or the state of their project
// (pending, demo, ended, client, rejected) so the page can take them to the right place. `website` is the site they typed
// on the page; it only ever finds one of THEIR projects. The draft saved so far comes back with it.
router.get('/get-started/resume', requireAuth, async (req, res, next) => {
  try {
    let project = await findResumeProject(req.userId, { website: String(req.query.website || '') });
    const saved = await getDraft(req.userId);
    // A trial that ended more than 30 days ago is treated as new: nothing to go back to, so the questions start again.
    let access = project ? describeAccess(await getSiteAccess(project.id)) : null;
    if (access && endedBeyondGrace(access)) { project = null; access = null; }
    // `draft` is null once the answers are gone (empty, or kept longer than staff allow); `returning` says how long they were away.
    if (!project) {
      const { draft, returning } = await resumeContext(req.userId, saved);
      return res.json({ state: 'new', project: null, draft, returning });
    }
    const draft = saved;
    res.json({ state: access.state, requested: access.requested, daysLeft: access.daysLeft, endsAt: access.endsAt,
      project: { id: project.id, name: project.name, domain: project.website_domain, current: Number(req.siteId) === project.id }, draft: access.state === 'client' ? null : draft, returning: null });
  } catch (e) { next(e); }
});

// The answers so far, saved as the person goes, so they can leave and carry on tomorrow or on another device.
router.get('/onboarding/draft', requireAuth, async (req, res, next) => {
  try { res.json(await getDraft(req.userId)); } catch (e) { next(e); }
});
router.put('/onboarding/draft', requireAuth, async (req, res, next) => {
  try {
    const draft = cleanDraft(req.body);
    if (!draft) return res.status(400).json({ error: 'That draft is not valid, or it is too large.' });
    await saveDraft(req.userId, draft);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/onboarding/draft', requireAuth, async (req, res, next) => {
  try { await deleteDraft(req.userId); res.json({ ok: true }); } catch (e) { next(e); }
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

    let existing = await findExistingProject(req.userId, domain.domain);
    // Their old trial ended more than 30 days ago: this is a new trial, not a return to that project.
    if (existing && endedBeyondGrace(describeAccess(await getSiteAccess(existing.id)))) existing = null;
    if (existing) {
      await saveOnboarding(existing.id, data, req.userId);
      await deleteDraft(req.userId).catch(() => {});
      return res.json({ ok: true, existing: true, workspaceId: existing.workspace_id, project: { id: existing.id, name: existing.name, domain: existing.website_domain } });
    }

    const timezone = isValidTimezone(data.run.timeZone) ? data.run.timeZone : undefined;
    const goals = mapGoals(data.goals);
    // A goal needs a time frame; the page does not ask for one, so a gentle default is used (editable later).
    const goalCheck = goals.length
      ? validateGoal({ goals, growth: 'steady', months: 6, customText: goals.includes('custom') ? 'Report to clients' : undefined })
      : null;

    // "Add another project": the website goes into the workspace they already have, as one more project, not a second workspace.
    // It is a different project, so it is a request like any other: pending until staff approve it, and the approval email sends
    // them to sign in with an emailed code as always.
    if (req.body?.addToExisting === true) {
      const target = await findAddTarget(req.userId);
      if (!target) return res.status(409).json({ error: 'You can add another project once your workspace is active.', code: 'CANNOT_ADD' });
      let added = null;
      try {
        added = await createProject({ workspaceId: target.workspace_id, name: data.projectName || data.brand, websiteDomain: domain.domain, timezone });
        await markPending(added.id, { source: 'get-started', requested: true });
        if (goalCheck?.ok) await setProjectGoal({ siteId: added.id, ...goalCheck.goal, userId: req.userId });
        await saveOnboarding(added.id, data, req.userId);
      } catch (err) {
        if (added) await discardNewProject({ siteId: added.id, workspaceId: target.workspace_id }).catch((e) => console.error('[onboarding] could not take back the new project:', e.message));
        throw err;
      }
      req.workspaceId = target.workspace_id;
      await recordAuditEvent(req, {
        action: 'project.created', targetType: 'site', targetId: String(added.id), tenantSiteId: added.id, tenantName: added.name,
        metadata: { workspaceId: target.workspace_id, name: added.name, websiteDomain: added.website_domain, via: 'get-started', added: true }, success: true,
      });
      sendAccessRequestStaffNotice({
        companyName: added.name, websiteDomain: added.website_domain, contactEmail: req.session?.email || (await getUserById(req.userId))?.email || '',
        summary: summarizeOnboarding(data), reviewUrl: `${appOrigin(req)}/account?scope=platform`,
      }).catch((err) => console.error('[onboarding] staff notice failed:', err.message));
      const to = req.session?.email || (await getUserById(req.userId))?.email;
      if (to) sendAccessReceivedEmail({ companyName: added.name, contactEmail: to }).catch((err) => console.error('[onboarding] received email failed:', err.message));
      await deleteDraft(req.userId).catch(() => {});
      return res.status(201).json({ ok: true, existing: false, added: true, workspaceId: target.workspace_id, project: { id: added.id, name: added.name, domain: added.website_domain } });
    }

    // Same all-or-nothing shape as POST /workspaces: a failure part-way takes back what was made here.
    const workspace = await createWorkspace({ name: data.workspaceName || data.brand });
    let site = null;
    try {
      await addMember(workspace.id, req.userId, 'owner');
      site = await createProject({ workspaceId: workspace.id, name: data.projectName || data.brand, websiteDomain: domain.domain, timezone });
      await markPending(site.id, { source: 'get-started', requested: true });
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
    // Finishing Get Started is the request for access: tell staff, without letting a slow mail server fail the sign-up.
    sendAccessRequestStaffNotice({
      companyName: site.name, websiteDomain: site.website_domain, contactEmail: req.session?.email || (await getUserById(req.userId))?.email || '',
      summary: summarizeOnboarding(data), reviewUrl: `${appOrigin(req)}/account?scope=platform`,
    }).catch((err) => console.error('[onboarding] staff notice failed:', err.message));
    // And tell the visitor we have it, the same words as the screen they just saw.
    const mailTo = req.session?.email || (await getUserById(req.userId))?.email;
    if (mailTo) sendAccessReceivedEmail({ companyName: site.name, contactEmail: mailTo }).catch((err) => console.error('[onboarding] received email failed:', err.message));
    await deleteDraft(req.userId).catch(() => {});
    res.status(201).json({ ok: true, existing: false, workspaceId: workspace.id, project: { id: site.id, name: site.name, domain: site.website_domain } });
  } catch (err) { next(err); }
});

export default router;
