import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';
import {
  getSiteAccess, describeAccess, effectiveState, isLocked, isAllowedWhileLocked, requestAccess,
  approveAccess, makeClient, rejectAccess, endDemo, renewDemo, listAccessForStaff, summarizeOnboarding, getOwnerContact, getSignupDetails,
} from '../store/access.js';
import { sendAccessClientEmail, sendAccessDemoEmail, sendReturnApprovedEmail } from '../report/email.js';
import { listReturnRequests, decideReturnRequest } from '../store/returning.js';
import { issueLoginCode, CODE_MINUTES } from '../store/login-codes.js';
import { query } from '../db.js';
import { appOrigin } from './lib/app-url.js';

// The free-trial approval flow (migration 219, server/store/access.js).
//
//   accessGate     a project that is 'pending', 'ended' or 'rejected' can only reach what isAllowedWhileLocked lists.
//   /access        the signed-in person's own state, and the button that asks for access.
//   /internal/...  staff: who asked, and approve (demo or client), renew, end, make client, reject.
const router = Router();

// A short memory per project, so the gate is not a database query on every request. A decision made in this process
// forgets it at once; another process sees it within the time below.
const CACHE_MS = 5000;
const cache = new Map();
const forget = (siteId) => cache.delete(Number(siteId));
async function accessOf(siteId) {
  const hit = cache.get(siteId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;
  const row = await getSiteAccess(siteId);
  cache.set(siteId, { at: Date.now(), row });
  return row;
}

// Staff are never held back: a platform admin opening a client's project (support) sees all of it.
const isStaffSession = (req) => {
  const company = Number(process.env.COMPANY_SITE_ID);
  return Boolean(company) && Number(req.session?.homeSiteId) === company;
};

export async function accessGate(req, res, next) {
  try {
    const siteId = req.session?.userId ? Number(req.session?.siteId) : 0;
    if (!siteId || isStaffSession(req)) return next();
    const row = await accessOf(siteId);
    if (!row || !isLocked(effectiveState(row))) return next();
    if (isAllowedWhileLocked({ method: req.method, path: req.originalUrl })) return next();
    return res.status(403).json({ error: 'This project is waiting for access to be approved.', code: 'ACCESS_LOCKED', state: effectiveState(row) });
  } catch (e) { return next(e); }
}

// ───────── the signed-in person ─────────

router.get('/access', requireAuth, async (req, res, next) => {
  try {
    if (!req.siteId) return res.json({ state: null, locked: false });
    res.json(describeAccess(await accessOf(req.siteId)));
  } catch (e) { next(e); }
});

router.post('/access/request', requireAuth, async (req, res, next) => {
  try {
    if (!req.siteId) return res.status(403).json({ error: 'Create a project first.' });
    const made = await requestAccess(req.siteId);
    forget(req.siteId);
    if (made) {
      await recordAuditEvent(req, {
        action: 'project.access_requested', targetType: 'site', targetId: String(req.siteId), tenantSiteId: req.siteId, success: true,
      });
    }
    res.status(made ? 201 : 200).json(describeAccess(await accessOf(req.siteId)));
  } catch (e) { next(e); }
});

// What the person set up on /get-started (brand, topics, prompts, competitors), for their dashboard. The prompts are listed
// here because the Keywords page does not show them yet: they are kept as a document with the project (migration 218).
router.get('/onboarding/summary', requireAuth, async (req, res, next) => {
  try {
    if (!req.siteId) return res.json(null);
    const { rows } = await query('SELECT data FROM site_onboarding WHERE site_id = $1', [req.siteId]);
    const data = rows[0]?.data;
    if (!data) return res.json(null);
    res.json({
      ...summarizeOnboarding(data),
      // The whole setup, so a demo's workspace page can show it as it was entered.
      profile: data.profile || null, markets: data.markets || null, run: data.run || null, runs: Array.isArray(data.runs) ? data.runs : [],
      entityCountry: data.entityCountry || null, workspaceName: data.workspaceName || null, projectName: data.projectName || null,
      promptList: (Array.isArray(data.prompts) ? data.prompts : []).slice(0, 200).map((p) => ({ text: p.text, topic: p.topic || null, intent: p.intent || null })),
    });
  } catch (e) { next(e); }
});

// ───────── staff ─────────

const staff = [requireAuth, requirePlatformRole('platform_admin')];

const publicRow = (r) => ({
  siteId: r.id, name: r.name, websiteDomain: r.website_domain,
  state: effectiveState(r), requestedAt: r.access_requested_at, endsAt: r.access_ends_at, endedAt: r.access_ended_at,
  decidedAt: r.access_decided_at, githubOptional: Boolean(r.access_github_optional), createdAt: r.created_at,
  owner: { email: r.owner_email || null, name: r.owner_name || null },
  setup: summarizeOnboarding(r.onboarding),
});

// Accounts that lost everything and asked to come back (server/store/returning.js). Approving sends them a fresh sign-in code.
router.get('/internal/returning', ...staff, async (req, res, next) => {
  try { res.json(await listReturnRequests()); } catch (e) { next(e); }
});
router.post('/internal/returning/:id/approve', ...staff, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const done = Number.isInteger(id) && id > 0 ? await decideReturnRequest(id, 'approved', req.userId) : null;
    if (!done) return res.status(409).json({ error: 'That request is not waiting any more.' });
    let emailed = false;
    try {
      const issued = await issueLoginCode(done.email);
      emailed = await sendReturnApprovedEmail({ email: done.email, code: issued.code || null, minutes: CODE_MINUTES, signInUrl: `${appOrigin(req)}/login?email=${encodeURIComponent(done.email)}` });
    } catch (err) { console.error('[returning] could not email the approval:', err.message); }
    await recordAuditEvent(req, { action: 'account.return_approved', targetType: 'user', targetId: String(done.user_id), success: true, metadata: { email: done.email } });
    res.json({ ok: true, emailed });
  } catch (e) { next(e); }
});
router.post('/internal/returning/:id/reject', ...staff, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const done = Number.isInteger(id) && id > 0 ? await decideReturnRequest(id, 'rejected', req.userId) : null;
    if (!done) return res.status(409).json({ error: 'That request is not waiting any more.' });
    await recordAuditEvent(req, { action: 'account.return_rejected', targetType: 'user', targetId: String(done.user_id), success: true, metadata: { email: done.email } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/internal/access/:siteId/details', ...staff, async (req, res, next) => {
  try {
    const siteId = Number(req.params.siteId);
    if (!Number.isInteger(siteId) || siteId <= 0) return res.status(400).json({ error: 'siteId is required.' });
    const d = await getSignupDetails(siteId);
    if (!d) return res.status(404).json({ error: 'No such project.' });
    res.json(d);
  } catch (e) { next(e); }
});

router.get('/internal/access', ...staff, async (req, res, next) => {
  try { res.json((await listAccessForStaff()).map(publicRow)); } catch (e) { next(e); }
});

// Tell the person what staff decided. Never fails the decision: it is already saved, and the screen says whether the
// email went (staff can approve again to resend, or write to them).
async function tellOwner(req, siteId, after, { renewed = false, upgraded = false } = {}) {
  try {
    const owner = await getOwnerContact(siteId);
    if (!owner?.email) return false;
    // Everyone approved signs in to the app: the demo (until it ends) and the client alike. The address is already filled in.
    const signInUrl = `${appOrigin(req)}/login?email=${encodeURIComponent(owner.email)}`;
    const base = { companyName: owner.name, contactEmail: owner.email, signInUrl };
    return after.access_state === 'demo'
      ? await sendAccessDemoEmail({ ...base, endsAt: after.access_ends_at, renewed })
      : await sendAccessClientEmail({ ...base, upgraded });
  } catch (err) {
    console.error(`[access] could not email the owner of site ${siteId}:`, err.message);
    return false;
  }
}

// One handler for every decision: look the project up, apply the change, log it, and (when asked) email the owner.
function decision(action, apply, { email = null } = {}) {
  return async (req, res, next) => {
    try {
      const siteId = Number(req.params.siteId);
      if (!Number.isInteger(siteId) || siteId <= 0) return res.status(400).json({ error: 'siteId is required.' });
      const before = await getSiteAccess(siteId);
      if (!before) return res.status(404).json({ error: 'No such project.' });
      const after = await apply({ siteId, body: req.body || {}, by: req.userId });
      forget(siteId);
      if (!after) return res.status(409).json({ error: 'That project is not in a state this can change.', state: effectiveState(before) });
      await recordAuditEvent(req, {
        action, targetType: 'site', targetId: String(siteId), tenantSiteId: siteId, tenantName: after.name,
        metadata: { from: effectiveState(before), to: after.access_state, endsAt: after.access_ends_at ?? null }, success: true,
      });
      const emailed = email ? await tellOwner(req, siteId, after, email) : null;
      res.json({ ...describeAccess(after), siteId, ...(emailed === null ? {} : { emailed }) });
    } catch (e) { next(e); }
  };
}

router.post('/internal/access/:siteId/approve', ...staff, decision('project.access_approved', ({ siteId, body, by }) => {
  if (!['demo', 'client'].includes(body.type)) { const e = new Error('Choose demo or client.'); e.status = 400; throw e; }
  return approveAccess(siteId, { type: body.type, githubOptional: body.githubOptional === true, decidedBy: by });
}, { email: {} }));
router.post('/internal/access/:siteId/make-client', ...staff, decision('project.access_made_client', ({ siteId, by }) => makeClient(siteId, { decidedBy: by }), { email: { upgraded: true } }));
router.post('/internal/access/:siteId/reject', ...staff, decision('project.access_rejected', ({ siteId, by }) => rejectAccess(siteId, { decidedBy: by })));
router.post('/internal/access/:siteId/renew', ...staff, decision('project.demo_renewed', ({ siteId, by }) => renewDemo(siteId, { decidedBy: by }), { email: { renewed: true } }));
router.post('/internal/access/:siteId/end', ...staff, decision('project.demo_ended_by_staff', async ({ siteId, by }) => {
  const ended = await endDemo(siteId, { reason: 'staff', decidedBy: by });
  return ended ? getSiteAccess(siteId) : null;
}));

export default router;
