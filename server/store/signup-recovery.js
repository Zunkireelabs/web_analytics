import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../db.js';

// Sign-up recovery (migration 224): the one reminder email, the resume link in it, how long saved answers are kept, and the
// staff view of who stopped where. The rules that need no database are exported separately so they can be tested without one.

const DAY_MS = 24 * 60 * 60 * 1000;

// ───────── steps ─────────

// The 11 steps a person goes through: two before the wizard (email, code), then the draft's step ids (the website's FLOW in
// src/scripts/get-started.js). 'wsname' is asked after the prompts, so it counts as having reached the last step.
export const FUNNEL_STEPS = ['Email', 'Code', 'Website', 'Brand', 'Company country', 'Run location', 'Brand profile', 'Goals', 'Markets', 'Topics', 'Prompts'];
const DRAFT_STEP_INDEX = { site: 3, brand: 4, entity: 5, run: 6, profile: 7, goals: 8, markets: 9, topics: 10, prompts: 11, wsname: 11 };
export const DRAFT_STEPS = Object.keys(DRAFT_STEP_INDEX);

// 1-based step reached. A finished sign-up (it has a project) reached them all.
export function stepReached({ draftStep = null, hasAnswers = false, verified = false, finished = false }) {
  if (finished) return FUNNEL_STEPS.length;
  if (hasAnswers && DRAFT_STEP_INDEX[draftStep]) return DRAFT_STEP_INDEX[draftStep];
  return verified ? (hasAnswers ? 3 : 2) : 1;
}

export const hasAnswers = (draft) => Boolean(draft?.data && typeof draft.data === 'object' && Object.keys(draft.data).length);

const list = (v, n = 50) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, n);

// What staff read in the side panel, from the draft the website saved ({ state }).
export function summarizeAnswers(data) {
  const s = data?.state && typeof data.state === 'object' ? data.state : {};
  return {
    website: s.website || s.domain || null,
    brand: s.brand || null,
    entityCountry: s.entity || null,
    run: { country: s.run?.country || null, language: s.run?.language || null, city: s.run?.city || null },
    profile: { products: list(s.profile?.products), personas: list(s.profile?.personas), competitors: list(s.profile?.competitors) },
    goals: list(s.goals, 6).map((key) => ({ key, confirmed: s.goalsTouched === true })),
    markets: list(s.markets?.items, 80),
    topics: list(s.topics),
    promptCount: Array.isArray(s.prompts) ? s.prompts.length : 0,
  };
}

// ───────── pure rules ─────────

export const DEFAULT_SETTINGS = { enabled: true, remindAfterDays: 7, linkDays: 2, keepDays: 30, confirmedOnly: true };
const DEFAULT_PURGE_DAY = 30;

// Checks a settings change against the current settings. Anything left out stays as it was.
export function validateSettings(input, current = DEFAULT_SETTINGS) {
  const body = input && typeof input === 'object' ? input : {};
  const next = { ...current };
  for (const key of ['enabled', 'confirmedOnly']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return { ok: false, error: `${key} must be true or false.` };
    next[key] = body[key];
  }
  const ranges = { remindAfterDays: [1, 60], linkDays: [1, 60], keepDays: [1, 365] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (body[key] === undefined) continue;
    const n = body[key];
    if (!Number.isInteger(n) || n < min || n > max) return { ok: false, error: `${key} must be a whole number from ${min} to ${max}.` };
    next[key] = n;
  }
  // A reminder after the answers are gone would never be sent.
  if (next.keepDays <= next.remindAfterDays) return { ok: false, error: 'Saved answers must be kept longer than the wait before the reminder.' };
  return { ok: true, settings: next };
}

// Has this draft waited long enough, and does this person qualify, for the one automatic reminder?
export function isReminderDue({ settings, draft, verified, hasProject, isClient = false, now = new Date() }) {
  if (!settings?.enabled || !draft || !hasAnswers(draft)) return false;
  if (draft.remindersMuted || draft.reminderCount > 0 || hasProject || isClient) return false;
  if (settings.confirmedOnly && !verified) return false;
  const last = new Date(draft.updatedAt).getTime();
  const age = now.getTime() - last;
  return age >= settings.remindAfterDays * DAY_MS && age < settings.keepDays * DAY_MS;
}

// The reminder column of the staff table.
export function reminderState({ status, settings, draft, verified, link = null, now = new Date() }) {
  if (status === 'client') return { state: 'client', dueAt: null, sentAt: null, count: 0, linkExpiresAt: null };
  const count = draft?.reminderCount || 0;
  const out = { dueAt: null, sentAt: draft?.reminderSentAt || null, count, linkExpiresAt: link?.expiresAt || null };
  if (draft?.remindersMuted) return { ...out, state: 'muted' };
  if (count > 0) {
    const cameBack = Boolean(link?.usedAt) || new Date(draft.updatedAt).getTime() > new Date(draft.reminderSentAt).getTime() || status !== 'unfinished';
    if (cameBack) return { ...out, state: 'back' };
    return { ...out, state: link && new Date(link.expiresAt).getTime() <= now.getTime() ? 'expired' : 'sent' };
  }
  if (status !== 'unfinished' || !hasAnswers(draft)) return { ...out, state: 'none' };
  if (settings.confirmedOnly && !verified) return { ...out, state: 'none' };
  if (!settings.enabled) return { ...out, state: 'none' };
  const dueAt = new Date(new Date(draft.updatedAt).getTime() + settings.remindAfterDays * DAY_MS);
  return { ...out, dueAt, state: dueAt.getTime() <= now.getTime() ? 'due' : 'scheduled' };
}

// Coming back to /get-started with email and code: how long ago did they stop? 'recent' up to 9 days, 'late' up to keepDays,
// 'fresh' when their answers are gone (deleted after keepDays) but they had signed up before. `staleDraft` tells the caller
// to treat a draft that outlived keepDays (not yet deleted by the job) as gone.
export function returningBucket({ draft, signedUpAt = null, keepDays = DEFAULT_SETTINGS.keepDays, now = new Date() }) {
  const days = (from) => Math.floor((now.getTime() - new Date(from).getTime()) / DAY_MS);
  if (hasAnswers(draft)) {
    const daysAway = Math.max(0, days(draft.updatedAt));
    if (daysAway > keepDays) return { bucket: 'fresh', daysAway, lastAnsweredAt: draft.updatedAt, staleDraft: true };
    return { bucket: daysAway <= 9 ? 'recent' : 'late', daysAway, lastAnsweredAt: draft.updatedAt, staleDraft: false };
  }
  if (!signedUpAt) return null;
  const daysAway = Math.max(0, days(signedUpAt));
  return daysAway > keepDays ? { bucket: 'fresh', daysAway, lastAnsweredAt: signedUpAt, staleDraft: false } : null;
}

export const GATE_MESSAGES = {
  SETUP_NOT_FINISHED: 'You have not finished setting up. Pick up where you left off on the sign-up page.',
  REQUEST_PENDING: 'We are reviewing your request. We will email you as soon as it is approved.',
  TRIAL_ENDED: 'Your free trial has ended. Talk to us to keep going.',
};

// Should the app sign-in send a code, or tell this person something first? `states` are the access states of the projects they
// can reach (a demo past its date counts as ended). Staff are never held back. Someone with a running demo or a client project
// gets their code; someone whose projects were all turned down (rejected) gets one too, and finds the lock inside.
export function decideCodeGate({ states = [], started = false, isStaff = false }) {
  if (isStaff) return null;
  if (!states.length) return started ? { code: 'SETUP_NOT_FINISHED', error: GATE_MESSAGES.SETUP_NOT_FINISHED } : null;
  if (states.some((s) => s === 'demo' || s === 'client')) return null;
  if (states.includes('pending')) return { code: 'REQUEST_PENDING', error: GATE_MESSAGES.REQUEST_PENDING };
  if (states.includes('ended')) return { code: 'TRIAL_ENDED', error: GATE_MESSAGES.TRIAL_ENDED };
  return null;
}

// ───────── tokens ─────────

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');
const siteBase = () => String(process.env.SITE_BASE_URL || 'https://superrank.si').trim().replace(/\/+$/, '');
const appBase = () => String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
export const resumeUrl = (token) => `${siteBase()}/get-started?resume=${encodeURIComponent(token)}`;

// The unsubscribe link carries no secret in the database: it is the user id plus a signature only the server can make.
const unsubSig = (userId) => createHmac('sha256', process.env.SESSION_SECRET || 'dev-only').update(`signup-unsubscribe:${userId}`).digest('hex').slice(0, 32);
export const unsubscribeToken = (userId) => `${userId}.${unsubSig(userId)}`;
export function readUnsubscribeToken(token) {
  const [id, sig] = String(token || '').split('.');
  if (!/^\d{1,10}$/.test(id || '') || !sig) return null;
  const want = Buffer.from(unsubSig(id)); const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? Number(id) : null;
}
export const unsubscribeUrl = (userId) => `${appBase()}/api/get-started/unsubscribe?token=${unsubscribeToken(userId)}`;

// ───────── settings ─────────

const toSettings = (r) => ({ enabled: r.enabled, remindAfterDays: r.remind_after_days, linkDays: r.link_days, keepDays: r.keep_days, confirmedOnly: r.confirmed_only });

export async function getSettings() {
  const { rows } = await query('SELECT * FROM signup_recovery_settings LIMIT 1');
  return rows[0] ? toSettings(rows[0]) : { ...DEFAULT_SETTINGS };
}

export async function getPurgeDay() {
  const { rows } = await query('SELECT purge_day FROM signup_recovery_settings LIMIT 1');
  return rows[0]?.purge_day ?? DEFAULT_PURGE_DAY;
}

export async function saveSettings(input) {
  const checked = validateSettings(input, await getSettings());
  if (!checked.ok) return checked;
  const s = checked.settings;
  await query(
    `INSERT INTO signup_recovery_settings (id, enabled, remind_after_days, link_days, keep_days, confirmed_only) VALUES (true, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, remind_after_days = EXCLUDED.remind_after_days, link_days = EXCLUDED.link_days,
       keep_days = EXCLUDED.keep_days, confirmed_only = EXCLUDED.confirmed_only, updated_at = now()`,
    [s.enabled, s.remindAfterDays, s.linkDays, s.keepDays, s.confirmedOnly]);
  return { ok: true, settings: s };
}

// ───────── resume links ─────────

// Makes a one-person link. Only the hash is stored; the token itself is returned once.
export async function createResumeLink(userId, { days }) {
  const token = randomBytes(32).toString('base64url');
  await query(`INSERT INTO signup_resume_links (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`, [sha256(token), userId, String(days)]);
  return { token, url: resumeUrl(token) };
}

// Uses a link up. Single use, decided in the UPDATE itself so two clicks cannot both win.
// -> { ok:true, userId } | { ok:false, reason:'invalid' | 'expired' }
export async function redeemResumeLink(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return { ok: false, reason: 'invalid' };
  const hash = sha256(token);
  const { rows } = await query(`SELECT id, user_id, expires_at, used_at FROM signup_resume_links WHERE token_hash = $1`, [hash]);
  const link = rows[0];
  if (!link || link.used_at) return { ok: false, reason: 'invalid' };
  if (new Date(link.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  const used = await query(`UPDATE signup_resume_links SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now()`, [link.id]);
  return used.rowCount === 1 ? { ok: true, userId: link.user_id } : { ok: false, reason: 'invalid' };
}

// ───────── muting ─────────

// Stops (or allows) the reminder. A person with no draft row gets an empty one, so "unsubscribe" still holds if they come back
// after their answers were deleted.
export async function setMuted(userId, muted) {
  await query(
    `INSERT INTO onboarding_drafts (user_id, step, data, reminders_muted) VALUES ($1, NULL, '{}'::jsonb, $2)
     ON CONFLICT (user_id) DO UPDATE SET reminders_muted = EXCLUDED.reminders_muted`, [userId, Boolean(muted)]);
}

// ───────── staff list ─────────

const draftOf = (r) => (r.d_updated_at ? {
  step: r.d_step, data: r.d_data, updatedAt: r.d_updated_at, reminderSentAt: r.reminder_sent_at, reminderCount: r.reminder_count || 0, remindersMuted: Boolean(r.reminders_muted),
} : null);

// 'unconfirmed' (typed an email, no code yet), 'unfinished', or the state of the project they made.
function personStatus({ verified, states }) {
  if (states.includes('client')) return 'client';
  if (states.includes('demo')) return 'trial';
  if (states.includes('pending')) return 'waiting';
  if (states.length) return 'ended';
  return verified ? 'unfinished' : 'unconfirmed';
}

export function buildProgress(rows, settings, now = new Date()) {
  const people = rows.map((r) => {
    const states = (r.states || []).filter(Boolean);
    const verified = Boolean(r.verified_at);
    const status = personStatus({ verified, states });
    const finished = !['unconfirmed', 'unfinished'].includes(status);
    const draft = draftOf(r);
    const answered = hasAnswers(draft);
    const answers = summarizeAnswers(answered ? draft.data : null);
    const step = stepReached({ draftStep: draft?.step, hasAnswers: answered, verified, finished });
    const link = r.link_expires_at ? { expiresAt: r.link_expires_at, usedAt: r.link_used_at } : null;
    return {
      userId: r.user_id || null, email: r.email, brand: answers.brand, website: answers.website, via: r.via, verified, step, stepName: FUNNEL_STEPS[step - 1],
      startedAt: r.created_at, lastActiveAt: r.last_active_at, status,
      reminder: reminderState({ status, settings, draft, verified, link, now }), answers,
    };
  });
  const funnel = FUNNEL_STEPS.map((name, i) => ({ step: i + 1, name, reached: people.filter((p) => p.step >= i + 1).length }));
  const counts = {
    started: people.length,
    finished: people.filter((p) => !['unconfirmed', 'unfinished'].includes(p.status)).length,
    stopped: people.filter((p) => ['unconfirmed', 'unfinished'].includes(p.status)).length,
    reminded: people.filter((p) => p.reminder.count > 0).length,
    cameBack: people.filter((p) => p.reminder.state === 'back').length,
  };
  return { counts, funnel, rows: people };
}

// Everyone who typed an email on /get-started in the last `days` days (or answered in that time), newest activity first.
export async function listProgress({ days = 30, now = new Date() } = {}) {
  const settings = await getSettings();
  const span = Math.min(365, Math.max(1, Math.round(Number(days) || 30)));
  const { rows } = await query(
    `SELECT gs.email, gs.via, gs.user_id, gs.verified_at, gs.created_at,
            GREATEST(d.updated_at, gs.verified_at, gs.created_at) AS last_active_at,
            d.step AS d_step, d.data AS d_data, d.updated_at AS d_updated_at, d.reminder_sent_at, d.reminder_count, d.reminders_muted,
            pr.states, l.expires_at AS link_expires_at, l.used_at AS link_used_at
       FROM get_started_signups gs
       LEFT JOIN onboarding_drafts d ON d.user_id = gs.user_id
       LEFT JOIN LATERAL (
         SELECT array_agg(DISTINCT CASE WHEN s.access_state = 'demo' AND s.access_ends_at <= now() THEN 'ended' ELSE s.access_state END) AS states
           FROM sites s
          WHERE s.status IS DISTINCT FROM 'soft_deleted'
            AND s.workspace_id IN (SELECT m.workspace_id FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = gs.user_id AND w.deleted_at IS NULL)
       ) pr ON true
       LEFT JOIN LATERAL (
         SELECT expires_at, used_at FROM signup_resume_links WHERE user_id = gs.user_id ORDER BY created_at DESC LIMIT 1
       ) l ON true
      WHERE GREATEST(d.updated_at, gs.verified_at, gs.created_at) >= $1
      ORDER BY last_active_at DESC LIMIT 500`, [new Date(now.getTime() - span * DAY_MS)]);
  return { ...buildProgress(rows, settings, now), settings };
}

// ───────── reminders ─────────

const fmtCountry = (code) => { try { return code ? new Intl.DisplayNames(['en'], { type: 'region' }).of(code) : ''; } catch { return code || ''; } };
const joinLine = (parts) => parts.filter(Boolean).join(' · ');

// The one-line detail under each finished group in the email.
export function reminderLines(answers) {
  const a = answers || {};
  return {
    'Website and brand': joinLine([a.website, a.brand]),
    'Where you sell': joinLine([fmtCountry(a.entityCountry), a.run?.city ? `prompts run from ${a.run.city}` : a.run?.country ? `prompts run from ${fmtCountry(a.run.country)}` : '']),
    'Brand profile': joinLine([a.profile?.products?.slice(0, 2).join(', '), a.profile?.competitors?.length ? `${a.profile.competitors.length} competitor${a.profile.competitors.length === 1 ? '' : 's'}` : '']),
  };
}

// The facts the reminder needs about one person: their login, draft and whether they already have a project.
async function loadPerson(userId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.status, d.step, d.data, d.updated_at, d.reminder_sent_at, d.reminder_count, d.reminders_muted,
            (gs.verified_at IS NOT NULL) AS verified,
            EXISTS (SELECT 1 FROM sites s WHERE s.status IS DISTINCT FROM 'soft_deleted'
                      AND (s.workspace_id IN (SELECT m.workspace_id FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = u.id AND w.deleted_at IS NULL)
                           OR s.id IN (SELECT site_id FROM project_members WHERE user_id = u.id) OR s.id = u.site_id)) AS has_project
       FROM users u LEFT JOIN onboarding_drafts d ON d.user_id = u.id LEFT JOIN get_started_signups gs ON gs.user_id = u.id
      WHERE u.id = $1`, [userId]);
  const r = rows[0];
  if (!r) return null;
  return {
    userId: r.id, email: r.email, active: r.status === 'active', verified: Boolean(r.verified), hasProject: Boolean(r.has_project),
    draft: r.updated_at ? { step: r.step, data: r.data, updatedAt: r.updated_at, reminderSentAt: r.reminder_sent_at, reminderCount: r.reminder_count || 0, remindersMuted: Boolean(r.reminders_muted) } : null,
  };
}

// Makes the link, mails the reminder and counts it. Returns { emailed } (false when mail is not set up here, in which case
// nothing is counted, so the cron tries again tomorrow).
async function deliverReminder(person, settings) {
  const { sendSignupReminderEmail } = await import('../report/email.js');
  const answers = summarizeAnswers(person.draft.data);
  const link = await createResumeLink(person.userId, { days: settings.linkDays });
  const emailed = await sendSignupReminderEmail({
    email: person.email, brand: answers.brand || answers.website, step: stepReached({ draftStep: person.draft.step, hasAnswers: true, verified: true }),
    lines: reminderLines(answers), resumeUrl: link.url, linkDays: settings.linkDays, keepDays: settings.keepDays,
    unsubscribeUrl: unsubscribeUrl(person.userId), lastAnswered: person.draft.updatedAt,
  });
  if (!emailed) return { emailed: false };
  await query(`UPDATE onboarding_drafts SET reminder_sent_at = now(), reminder_count = reminder_count + 1 WHERE user_id = $1`, [person.userId]);
  return { emailed: true };
}

// Staff pressed "Send reminder now". -> { ok, emailed } or { ok:false, code } for the route to explain.
export async function sendReminderNow(userId) {
  const person = await loadPerson(userId);
  if (!person) return { ok: false, code: 'not_found' };
  if (person.hasProject) return { ok: false, code: 'has_project' };
  if (!person.active) return { ok: false, code: 'disabled' };
  if (!hasAnswers(person.draft)) return { ok: false, code: 'no_answers' };
  const { emailed } = await deliverReminder(person, await getSettings());
  return { ok: true, emailed };
}

// A link without the email (staff copy it to send some other way). Does not count as the reminder.
export async function resumeLinkFor(userId) {
  const person = await loadPerson(userId);
  if (!person) return null;
  return createResumeLink(userId, { days: (await getSettings()).linkDays });
}

const CRON_BATCH = 200;

// The daily job: one reminder to each person who qualifies. Returns how many went out.
export async function runSignupReminders({ now = new Date() } = {}) {
  const settings = await getSettings();
  if (!settings.enabled) return { sent: 0, skipped: 'disabled' };
  const { rows } = await query(
    `SELECT d.user_id FROM onboarding_drafts d JOIN users u ON u.id = d.user_id
       LEFT JOIN get_started_signups gs ON gs.user_id = u.id
      WHERE d.reminder_count = 0 AND NOT d.reminders_muted AND d.data <> '{}'::jsonb
        AND d.updated_at <= $1 AND d.updated_at > $2 AND u.status = 'active'
        AND ($3::boolean = false OR gs.verified_at IS NOT NULL)
      ORDER BY d.updated_at LIMIT ${CRON_BATCH}`,
    [new Date(now.getTime() - settings.remindAfterDays * DAY_MS), new Date(now.getTime() - settings.keepDays * DAY_MS), settings.confirmedOnly]);
  let sent = 0;
  for (const { user_id: userId } of rows) {
    try {
      const person = await loadPerson(userId);
      if (!person || !person.active || !isReminderDue({ settings, draft: person.draft, verified: person.verified, hasProject: person.hasProject, now })) continue;
      if ((await deliverReminder(person, settings)).emailed) sent++;
    } catch (err) {
      console.error(`[signup-recovery] reminder for user ${userId} failed:`, err.message);
    }
  }
  return { sent, checked: rows.length };
}

// ───────── keeping and deleting ─────────

// Saved answers older than keepDays are deleted. A row someone unsubscribed from is emptied instead, so the unsubscribe holds.
export async function purgeOldDrafts({ now = new Date() } = {}) {
  const { keepDays } = await getSettings();
  const cutoff = new Date(now.getTime() - keepDays * DAY_MS);
  const gone = await query(`DELETE FROM onboarding_drafts WHERE updated_at < $1 AND NOT reminders_muted`, [cutoff]);
  const blanked = await query(`UPDATE onboarding_drafts SET data = '{}'::jsonb, step = NULL WHERE updated_at < $1 AND reminders_muted AND data <> '{}'::jsonb`, [cutoff]);
  await query(`DELETE FROM signup_resume_links WHERE expires_at < $1`, [new Date(now.getTime() - 7 * DAY_MS)]);
  return { deleted: gone.rowCount || 0, emptied: blanked.rowCount || 0 };
}

// Where a person stands for the /get-started/resume answer: the draft (null when it is empty or outlived keepDays), and the
// "welcome back" bucket.
export async function resumeContext(userId, draft, { now = new Date() } = {}) {
  const { keepDays } = await getSettings();
  const { rows } = await query(`SELECT COALESCE(verified_at, updated_at) AS since FROM get_started_signups WHERE user_id = $1 AND verified_at IS NOT NULL`, [userId]);
  const found = returningBucket({ draft, signedUpAt: rows[0]?.since || null, keepDays, now });
  const { staleDraft, ...returning } = found || {};
  const keep = hasAnswers(draft) && !staleDraft;
  return { draft: keep ? draft : null, returning: found ? returning : null };
}

// The facts the app sign-in needs to decide whether a code is useful (see decideCodeGate).
export async function getCodeGateFacts(userId) {
  const { rows } = await query(
    `SELECT CASE WHEN s.access_state = 'demo' AND s.access_ends_at <= now() THEN 'ended' ELSE s.access_state END AS state
       FROM sites s
      WHERE s.status IS DISTINCT FROM 'soft_deleted'
        AND (s.workspace_id IN (SELECT m.workspace_id FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1 AND w.deleted_at IS NULL)
             OR s.id IN (SELECT site_id FROM project_members WHERE user_id = $1)
             OR s.id = (SELECT site_id FROM users WHERE id = $1))`, [userId]);
  const started = await query(
    `SELECT 1 FROM onboarding_drafts WHERE user_id = $1 AND data <> '{}'::jsonb
     UNION ALL SELECT 1 FROM get_started_signups WHERE user_id = $1 AND verified_at IS NOT NULL LIMIT 1`, [userId]);
  return { states: rows.map((r) => r.state), started: started.rows.length > 0 };
}

// ───────── ended demos ─────────

export const purgeEndedEnabled = (env = process.env) => String(env.SIGNUP_PURGE_ENDED_ENABLED || '').toLowerCase() === 'true';

// Demos that ended, were approved purgeDay or more days ago, and were made on /get-started. Real clients, running demos,
// waiting and turned-down projects never match: only access_state = 'ended' does.
export async function listEndedDemosToPurge({ purgeDay, now = new Date() }) {
  const { rows } = await query(
    `SELECT id, name, workspace_id, access_decided_at FROM sites
      WHERE access_state = 'ended' AND access_source = 'get-started' AND status IS DISTINCT FROM 'soft_deleted'
        AND access_decided_at IS NOT NULL AND access_decided_at <= $1 AND id <> $2
      ORDER BY id`, [new Date(now.getTime() - purgeDay * DAY_MS), Number(process.env.COMPANY_SITE_ID) || 0]);
  return rows;
}

// Deletes (apply) or only lists (the default) the ended demos that are due. Uses the same plan and the same
// suspend -> soft-delete -> hard-delete path as scripts/delete-site.js, then the empty workspace and the people who belonged
// only to it, so the same email counts as brand new afterwards.
export async function purgeEndedDemos({ apply = false, now = new Date() } = {}) {
  const purgeDay = await getPurgeDay();
  const due = await listEndedDemosToPurge({ purgeDay, now });
  const out = { dryRun: !apply, purgeDay, due: due.map((s) => s.id), deleted: [], skipped: [] };
  if (!apply || !due.length) return out;
  const { planSiteDeletion } = await import('../scripts/delete-site.js');
  const { suspendSite, softDeleteSite, hardDeleteSite } = await import('../db.js');
  const { recordAuditEvent } = await import('./admin/audit-log.js');
  for (const site of due) {
    try {
      const one = async (sql, p) => (await query(sql, p)).rows[0] || null;
      const full = await one('SELECT id, name, status, workspace_id FROM sites WHERE id = $1', [site.id]);
      const homeUsers = (await query('SELECT id, email, role FROM users WHERE site_id = $1', [site.id])).rows;
      const elsewhere = {};
      for (const u of homeUsers) {
        const w = await one('SELECT count(*)::int AS n FROM workspace_members WHERE user_id = $1 AND workspace_id IS DISTINCT FROM $2', [u.id, full.workspace_id]);
        const p = await one('SELECT count(*)::int AS n FROM project_members WHERE user_id = $1 AND site_id <> $2', [u.id, site.id]);
        elsewhere[u.id] = { workspaces: w.n, projects: p.n };
      }
      const count = full.workspace_id ? (await one('SELECT count(*)::int AS n FROM sites WHERE workspace_id = $1', [full.workspace_id])).n : 0;
      const plan = planSiteDeletion({ site: full, companySiteId: process.env.COMPANY_SITE_ID, homeUsers, elsewhere, workspaceSiteCount: count });
      if (!plan.ok) { out.skipped.push({ id: site.id, why: plan.problems.join(' ') }); continue; }

      const members = full.workspace_id ? (await query('SELECT u.id, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1', [full.workspace_id])).rows : [];
      if (full.status === 'active' && !(await suspendSite(site.id))) throw new Error('could not suspend');
      if (!(await softDeleteSite(site.id)) || !(await hardDeleteSite(site.id))) throw new Error('could not delete (its status changed)');
      if (plan.removesWorkspace) {
        await query('DELETE FROM workspace_members WHERE workspace_id = $1', [full.workspace_id]);
        await query('DELETE FROM workspaces WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM sites WHERE workspace_id = $1)', [full.workspace_id]);
        // People who belonged only to it. A login whose home was this site went with the site (users.site_id cascades).
        for (const m of members) {
          await query(
            `DELETE FROM users WHERE id = $1 AND role IS DISTINCT FROM 'platform_admin'
               AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE user_id = $1) AND NOT EXISTS (SELECT 1 FROM project_members WHERE user_id = $1)`, [m.id]);
        }
      }
      const emails = [...new Set([...members.map((m) => m.email), ...homeUsers.map((u) => u.email)])];
      if (emails.length) await query('DELETE FROM get_started_signups WHERE email = ANY($1)', [emails]);
      await recordAuditEvent({ userId: null }, { action: 'project.demo_purged', targetType: 'site', targetId: String(site.id), tenantName: full.name, metadata: { purgeDay, workspaceRemoved: plan.removesWorkspace }, success: true });
      out.deleted.push(site.id);
    } catch (err) {
      console.error(`[signup-recovery] could not purge ended demo ${site.id}:`, err.message);
      out.skipped.push({ id: site.id, why: err.message });
    }
  }
  return out;
}
