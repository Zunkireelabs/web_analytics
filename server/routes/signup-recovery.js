import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';
import { getUserById } from '../store/users.js';
import { listProgress, getSettings, saveSettings, sendReminderNow, resumeLinkFor, setMuted, readUnsubscribeToken } from '../store/signup-recovery.js';

// Sign-up recovery (migration 224, server/store/signup-recovery.js). Staff see who stopped on /get-started and can remind them;
// the unsubscribe link in the reminder is public. The resume link itself is redeemed in routes/login.js, next to the code sign-in.
const router = Router();
const staff = [requireAuth, requirePlatformRole('platform_admin')];

const userIdOf = (req) => { const id = Number(req.params.userId); return Number.isInteger(id) && id > 0 ? id : null; };
const audit = (req, action, userId, metadata = null) => recordAuditEvent(req, { action, targetType: 'user', targetId: String(userId), metadata, success: true });

router.get('/platform/signup-progress', ...staff, async (req, res, next) => {
  try { res.json(await listProgress({ days: req.query.days })); } catch (e) { next(e); }
});

const REMIND_REFUSED = {
  not_found: [404, 'Not found.'],
  has_project: [409, 'This person already has a project, so there is nothing to remind them about.'],
  disabled: [409, 'This account is disabled.'],
  no_answers: [409, 'This person has no saved answers to come back to.'],
};
router.post('/platform/signup-progress/:userId/remind', ...staff, async (req, res, next) => {
  try {
    const userId = userIdOf(req);
    if (!userId) return res.status(404).json({ error: 'Not found.' });
    const out = await sendReminderNow(userId);
    if (!out.ok) { const [status, error] = REMIND_REFUSED[out.code]; return res.status(status).json({ error }); }
    await audit(req, 'platform.signup_reminder_sent', userId, { emailed: out.emailed });
    res.json({ ok: true, emailed: out.emailed });
  } catch (e) { next(e); }
});

router.post('/platform/signup-progress/:userId/mute', ...staff, async (req, res, next) => {
  try {
    const userId = userIdOf(req);
    if (!userId || !(await getUserById(userId))) return res.status(404).json({ error: 'Not found.' });
    if (typeof req.body?.muted !== 'boolean') return res.status(400).json({ error: 'muted must be true or false.' });
    await setMuted(userId, req.body.muted);
    await audit(req, 'platform.signup_reminder_muted', userId, { muted: req.body.muted });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/platform/signup-progress/:userId/resume-link', ...staff, async (req, res, next) => {
  try {
    const userId = userIdOf(req);
    const link = userId ? await resumeLinkFor(userId) : null;
    if (!link) return res.status(404).json({ error: 'Not found.' });
    await audit(req, 'platform.signup_resume_link_made', userId);
    res.json({ url: link.url });
  } catch (e) { next(e); }
});

router.get('/platform/signup-recovery/settings', ...staff, async (req, res, next) => {
  try { res.json(await getSettings()); } catch (e) { next(e); }
});
router.put('/platform/signup-recovery/settings', ...staff, async (req, res, next) => {
  try {
    const out = await saveSettings(req.body);
    if (!out.ok) return res.status(400).json({ error: out.error });
    await recordAuditEvent(req, { action: 'platform.signup_recovery_settings', targetType: 'settings', targetId: 'signup_recovery', metadata: out.settings, success: true });
    res.json(out.settings);
  } catch (e) { next(e); }
});

// Public: the link at the foot of the reminder. A GET that changes something, on purpose (an email link cannot POST); the
// worst a mail scanner can do with it is stop one reminder. The page names nothing about the person.
const page = (title, text) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="margin:0;background:#fbfaf8;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#171717"><div style="max-width:420px;margin:15vh auto;padding:32px 28px;background:#fff;border-radius:12px;box-shadow:0 0 0 1px #f0f0f0">
<h1 style="margin:0;font-size:24px;font-weight:500">${title}</h1><p style="margin:12px 0 0;font-size:14px;line-height:21px;color:#525252">${text}</p></div></body></html>`;
router.get('/get-started/unsubscribe', async (req, res, next) => {
  try {
    const userId = readUnsubscribeToken(req.query.token);
    res.set('Cache-Control', 'no-store');
    if (!userId) return res.status(400).type('html').send(page('This link is not valid', 'It may be incomplete. Reply to the email and we will stop the reminders for you.'));
    await setMuted(userId, true);
    res.type('html').send(page('You are unsubscribed', 'We will not send you any more reminders about finishing your setup. Your saved answers stay until they expire.'));
  } catch (e) { next(e); }
});

export default router;
