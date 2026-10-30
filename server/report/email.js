import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Catch-all redirect. When EMAIL_REDIRECT_TO is set, every outbound message
// from this file goes to that address INSTEAD of its real recipient.
//
// This exists because the staging VPS is currently the live automation host
// (see .github/workflows/deploy-staging.yml — "production (main) has never
// actually been deployed"), its 07:00/Thursday cron is deliberately live, and
// real client sites now share that database. Without this, the daily pipeline
// emails real clients from an environment that is still being changed daily.
//
// Applied by wrapping the shared transporter rather than at the five call
// sites below, so it is structurally impossible for a sender to miss it —
// including one added later. A sender that forgets a redirect is exactly the
// failure this is meant to prevent, so it must not be something a sender can
// forget.
//
// Unset in production, where mail must reach its real recipient.
// Exemption marker for mail that must always reach its real recipient even
// while the catch-all redirect is on.
//
// The redirect exists to stop BULK, SYSTEM-INITIATED reporting reaching real
// clients from an environment that changes several times a day. An invitation
// or a password reset is neither: it is addressed to one specific person who
// just asked for that exact link, seconds ago, and redirecting it doesn't
// protect them — it silently breaks the thing they requested and leaves an
// operator to forward links by hand.
//
// A Symbol rather than a string field so it cannot collide with any real
// nodemailer option, and it is deleted from the message before send, so
// nothing leaks into the SMTP envelope. Deliberately opt-IN per call site:
// the default for anything new stays redirected, which is the safe direction.
export const REDIRECT_EXEMPT = Symbol('redirect-exempt');

export function redirectTarget() {
  const to = (process.env.EMAIL_REDIRECT_TO || '').trim();
  return to || null;
}

// Rewrites one message for redirect mode. The original recipients are never
// silently discarded — they move into the subject and an X-Original-To
// header, so a redirected inbox can still tell who each mail was FOR. Without
// that, a morning's worth of redirected client reports is indistinguishable
// from a morning of one's own.
export function applyRedirect(message, target) {
  const original = [message.to, message.cc, message.bcc].filter(Boolean).join(', ') || '(none)';
  return {
    ...message,
    to: target,
    cc: undefined,
    bcc: undefined,
    subject: `[REDIRECTED → ${original}] ${message.subject || ''}`.trim(),
    headers: { ...(message.headers || {}), 'X-Original-To': original },
  };
}

export function devAllToTarget(env = process.env) {
  const to = String(env.DEV_MAIL_ALL_TO || '').trim();
  return to && env.NODE_ENV !== 'production' ? to : null;
}

// Wraps a real transporter so a developer's whole run lands in their own inbox: every message (the exemption
// flag is ignored here) goes to `target`, with the real recipient moved into the subject and an X-Original-To
// header, and a copy is kept in the local outbox folder when that is on.
export function devAllToWrap(transporter, target, { outbox = devOutboxTransporter() } = {}) {
  return {
    ...transporter,
    sendMail: async (message) => {
      const { [REDIRECT_EXEMPT]: _exempt, ...clean } = message || {};
      const redirected = applyRedirect(clean, target);
      if (outbox) await outbox.sendMail(redirected);
      console.log(`[email] DEV_MAIL_ALL_TO — "${message?.subject}" for ${redirected.headers['X-Original-To']} sent to ${target} instead.`);
      return transporter.sendMail(redirected);
    },
  };
}

// LOCAL TESTING ONLY. With no SMTP configured every email is silently skipped, so a sign-up on a developer's
// machine never shows the verification or sign-in message. When DEV_MAIL_OUTBOX names a folder (and this is not
// production) each message is written there as a page you can open, and its links are printed in the log.
// Nothing is ever sent anywhere. Unset, or in production, this does nothing and mail behaves exactly as before.
function devOutboxTransporter() {
  const dir = process.env.DEV_MAIL_OUTBOX;
  if (!dir || process.env.NODE_ENV === 'production') return null;
  return {
    sendMail: async (message) => {
      mkdirSync(dir, { recursive: true });
      const to = Array.isArray(message.to) ? message.to.join(', ') : String(message.to || '');
      const slug = String(message.subject || 'email').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'email';
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}.html`);
      const head = `<div style="font:13px system-ui;background:#f4f4f5;color:#333;padding:12px 16px;border-bottom:1px solid #ddd"><b>To:</b> ${escapeHtml(to)}<br><b>Subject:</b> ${escapeHtml(message.subject || '')}<br><i>Saved by the local mail outbox, not sent.</i></div>`;
      writeFileSync(file, `${head}${message.html || `<pre>${escapeHtml(message.text || '')}</pre>`}`);
      const links = [...String(message.html || message.text || '').matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((u) => /^https?:/.test(u));
      console.log(`[email:dev-outbox] "${message.subject}" to ${to} -> ${file}`);
      for (const link of links) console.log(`[email:dev-outbox]   link: ${link}`);
      return { messageId: `dev-outbox-${Date.now()}` };
    },
  };
}

// Mail health, for every sender at once. Mail that cannot go out used to leave only a log line, so a person
// waiting for a sign-in code or an approval link just waited. Every attempt is now recorded in Integration
// Health ('email'): sent, SMTP not configured, or the provider's own error. Recorded on a change of state
// (and at most every 10 minutes while it stays the same) so a busy day does not write a row per message.
let lastMailState = null;
let lastMailNoteAt = 0;
async function noteMail(ok, detail) {
  const state = ok ? 'ok' : detail;
  const now = Date.now();
  if (state === lastMailState && now - lastMailNoteAt < 10 * 60 * 1000) return;
  lastMailState = state; lastMailNoteAt = now;
  try {
    const { recordIntegrationCheck } = await import('../store/upsert.js');
    await recordIntegrationCheck('email', null, ok
      ? { ok: true, authStatus: 'valid', errorMessage: null, recoveryAction: null }
      : {
        ok: false, authStatus: detail === 'not_configured' ? 'not_configured' : null,
        errorMessage: detail === 'not_configured' ? 'Email is not configured on this server, so no email can be sent (sign-in codes, approval links, reports).' : String(detail).slice(0, 300),
        recoveryAction: detail === 'not_configured' ? 'Set SMTP_HOST, SMTP_USER and SMTP_PASS.' : 'Check the SMTP credentials and the provider status.',
      });
  } catch (err) {
    console.error('[email] could not record mail health:', err.message);
  }
}

// Shared by every email sender below — null if SMTP isn't configured, so
// each caller can skip silently rather than throw. Wrapped so that every send, from every sender, reports
// its outcome (see noteMail).
function getTransporter() {
  const t = buildTransporter();
  if (!t) { noteMail(false, 'not_configured'); return t; }
  return {
    ...t,
    sendMail: async (message) => {
      try {
        const r = await t.sendMail(message);
        noteMail(true);
        return r;
      } catch (err) {
        noteMail(false, err.message || 'send failed');
        throw err;
      }
    },
  };
}

function buildTransporter() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return devOutboxTransporter();

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE ?? 'true') === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  // LOCAL TESTING ONLY (never in production): deliver EVERY message, including the person-requested ones the
  // catch-all below exempts (sign-up, sign-in code, approval, password reset), to one test inbox instead.
  const allTo = devAllToTarget();
  if (allTo) return devAllToWrap(transporter, allTo);

  const target = redirectTarget();
  if (!target) return transporter;

  return {
    ...transporter,
    sendMail: (message) => {
      // Person-requested transactional mail is exempt — see REDIRECT_EXEMPT.
      // The flag is stripped before nodemailer ever sees the message.
      if (message?.[REDIRECT_EXEMPT]) {
        const { [REDIRECT_EXEMPT]: _exempt, ...clean } = message;
        console.log(`[email] redirect exempt (transactional) — "${message.subject}" delivered to its real recipient.`);
        return transporter.sendMail(clean);
      }
      const redirected = applyRedirect(message, target);
      console.log(`[email] REDIRECT ACTIVE — "${message.subject}" for ${redirected.headers['X-Original-To']} sent to ${target} instead.`);
      return transporter.sendMail(redirected);
    },
  };
}

// Builds a small HTML morning email from the day's metrics + AI narrative.
// Skips silently (returns false) if SMTP is not configured, so the rest of the
// pipeline still succeeds.
export async function sendDailyEmail(site, reportDate, day, narrative) {
  const recipient = site.report_email_to || process.env.REPORT_EMAIL_TO;
  const transporter = getTransporter();
  if (!transporter || !recipient) {
    console.log('[email] SMTP not fully configured — skipping email.');
    return false;
  }

  const n = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const card = (label, value) =>
    `<td style="padding:10px 14px;border:1px solid #eee;border-radius:8px">
       <div style="font-size:12px;color:#888">${label}</div>
       <div style="font-size:20px;font-weight:600;color:#111">${value}</div>
     </td>`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">
    <h2 style="margin:0 0 4px">${site.name} — ${reportDate}</h2>
    <p style="color:#555;margin:0 0 16px">Daily search & analytics summary</p>
    <table style="border-collapse:separate;border-spacing:8px"><tr>
      ${card('Clicks', n(day?.clicks))}
      ${card('Impressions', n(day?.impressions))}
      ${card('Users', n(day?.users))}
      ${card('Sessions', n(day?.sessions))}
    </tr></table>
    <p style="margin:18px 0;line-height:1.5;color:#222">${(narrative || '').replace(/\n/g, '<br>')}</p>
    <p style="color:#999;font-size:12px">Automated report. Open the dashboard for charts and history.</p>
  </div>`;

  await transporter.sendMail({
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to: recipient,
    subject: `${site.name}: ${n(day?.clicks)} clicks, ${n(day?.users)} users — ${reportDate}`,
    html,
  });
  console.log(`[email] sent to ${recipient}`);
  return true;
}

// Notifies the sales team of a new "Contact Us" lead from the landing page
// (POST /contact-requests — server/routes/login.js). Fixed recipient, not a
// per-client setting like REPORT_EMAIL_TO above — this is always the
// company's own inbox, never configurable per site.
const LEADS_EMAIL_TO = 'info@zunkireelabs.com';

// Contact form fields come straight from an unauthenticated public
// endpoint — escape before interpolating into HTML so a submitted
// name/message can't inject markup/links into the email staff read.
// Exported for reuse by the Phase 4 invitation/password-reset emails below,
// which interpolate a site name and role that ultimately trace back to a
// Platform/Tenant Admin's own input.
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function sendContactLeadEmail({ companyName, websiteDomain, contactEmail, message }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log('[email] SMTP not fully configured — skipping contact lead email.');
    return false;
  }

  const safeCompany = escapeHtml(companyName);
  const safeEmail = escapeHtml(contactEmail);
  const safeWebsite = websiteDomain ? escapeHtml(websiteDomain) : null;
  const safeMessage = message ? escapeHtml(message) : null;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">
    <h2 style="margin:0 0 4px">New Contact Us lead</h2>
    <p style="margin:0 0 16px;color:#555">${safeCompany}</p>
    <table style="border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#888">Email</td><td><a href="mailto:${safeEmail}">${safeEmail}</a></td></tr>
      ${safeWebsite ? `<tr><td style="padding:4px 12px 4px 0;color:#888">Website</td><td>${safeWebsite}</td></tr>` : ''}
    </table>
    ${safeMessage ? `<p style="margin:18px 0;line-height:1.5;color:#222;white-space:pre-wrap">${safeMessage}</p>` : ''}
  </div>`;

  await transporter.sendMail({
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to: LEADS_EMAIL_TO,
    subject: `New Contact Us lead: ${safeCompany}`,
    html,
  });
  console.log(`[email] contact lead notification sent to ${LEADS_EMAIL_TO}`);
  return true;
}

// PLATFORM-ADMIN-DESIGN.md §E — invite/accept flow. acceptUrl already
// carries the raw single-use token as a query param; this function never
// sees or needs the token_hash, same "raw value only ever exists at the one
// point it's minted" discipline as api_tokens/oauth tokens.
export async function sendInvitationEmail({ to, siteName, role, acceptUrl }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log('[email] SMTP not fully configured — skipping invitation email.');
    return false;
  }

  const safeSiteName = escapeHtml(siteName);
  const safeRole = escapeHtml(role.replace(/_/g, ' '));
  const safeUrl = escapeHtml(acceptUrl);

  const html = emailShell({
    eyebrow: 'Invitation',
    title: `You've been invited to <span style="color:${BRAND_ORANGE}">${safeSiteName}</span>`,
    intro: `You can join as <b>${safeRole}</b>. Accept the invitation to open the project.`,
    body: `<p style="margin:22px 0 0;text-align:center"><a href="${safeUrl}" style="${CARD_BUTTON}">Accept invitation</a></p>`,
    footnote: "This link expires in 7 days. If you weren't expecting this, you can ignore this email.",
  });

  await transporter.sendMail({
    [REDIRECT_EXEMPT]: true,
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject: `You've been invited to ${siteName}`,
    html,
  });
  console.log(`[email] invitation sent to ${to}`);
  return true;
}

// PLATFORM-ADMIN-DESIGN.md §E — admin-triggered reset, completion half.
export async function sendPasswordResetEmail({ to, resetUrl }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log('[email] SMTP not fully configured — skipping password reset email.');
    return false;
  }

  const safeUrl = escapeHtml(resetUrl);

  const html = emailShell({
    eyebrow: 'Password reset',
    title: 'Reset your password',
    intro: 'A staff member requested a password reset for your account. Choose a new password with the button below.',
    body: `<p style="margin:22px 0 0;text-align:center"><a href="${safeUrl}" style="${CARD_BUTTON}">Set a new password</a></p>`,
    footnote: "This link expires in 1 hour. If you weren't expecting this, you can ignore this email. Your password won't change.",
  });

  await transporter.sendMail({
    [REDIRECT_EXEMPT]: true,
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject: 'Reset your password',
    html,
  });
  console.log(`[email] password reset sent to ${to}`);
  return true;
}

// ───────── sign-up requests ─────────
//
// Three messages around one request. Wording lives in pure builders so what the
// person actually reads (and that nothing they typed can inject markup) is
// testable without sending anything.
//
// "Approval" is a person at SuperRank checking the request before an account
// exists, and the sign-up page promises exactly that — so the first email
// restates it plainly, and the approval email is what ends the wait.
const MAIL_STYLE = 'font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px';
const BUTTON_STYLE = 'background:#d54e00;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block';

// The look every message to a client shares: logo, a white card on a warm page, an orange eyebrow, a
// footnote. Table-based with inline styles, because mail apps ignore stylesheets. The logo is an
// image only when the app's public address is known (an email cannot load a relative path); without
// it the wordmark is plain text, which still reads as the brand.
const BRAND_ORANGE = '#d54e00';
function brandMark() {
  const base = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  // EMAIL_LOGO_URL: a developer's APP_BASE_URL is http://localhost:..., which no mail app can load, so locally the
  // logo is read from the live site instead. Unset (production), it comes from the app's own address as before.
  const logoUrl = String(process.env.EMAIL_LOGO_URL || '').trim() || (base ? `${base}/superrank-logo.png` : '');
  const img = logoUrl ? `<img src="${escapeHtml(logoUrl)}" width="22" height="22" alt="" style="vertical-align:middle;margin-right:6px">` : '';
  return `${img}<span style="font-size:19px;font-weight:600;letter-spacing:-.04em;vertical-align:middle;color:#171717">super<b style="color:${BRAND_ORANGE}">rank</b></span>`;
}
const CARD_BUTTON = `background:${BRAND_ORANGE};color:#fff;padding:12px 56px;border-radius:8px;text-decoration:none;display:inline-block;font-size:14px;font-weight:500`;

// `title`, `intro` and `body` are HTML the caller has already escaped.
export function emailShell({ eyebrow, title, intro, body = '', footnote = '' }) {
  return `
  <div style="background:#fbfaf8;padding:28px 14px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#171717">
   <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;margin:0 auto">
    <tr><td align="center" style="padding-bottom:18px">${brandMark()}</td></tr>
    <tr><td style="background:#fff;border-radius:12px;padding:32px 28px;box-shadow:0 0 0 1px #f0f0f0,0 1px 2px rgba(0,0,0,.04)">
     <p style="margin:0;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${BRAND_ORANGE};font-weight:500">${eyebrow}</p>
     <h1 style="margin:10px 0 0;font-size:26px;line-height:30px;font-weight:500;letter-spacing:-.03em">${title}</h1>
     <p style="margin:10px 0 0;font-size:14px;line-height:21px;color:#525252">${intro}</p>
     ${body}
     ${footnote ? `<p style="margin:18px 0 0;font-size:12px;line-height:18px;color:#8a8a8a;border-top:1px solid #f0f0f0;padding-top:14px">${footnote}</p>` : ''}
    </td></tr>
    <tr><td align="center" style="padding-top:16px;font-size:11px;color:#8a8a8a">SuperRank &middot; Your SEO agent, always working</td></tr>
   </table>
  </div>`;
}

const tint = (inner) => `<div style="margin:20px 0 0;background:#fff4ed;border-radius:10px;box-shadow:inset 0 0 0 1px #ffe1cc;padding:14px 16px;font-size:13px;line-height:19px;color:#525252">${inner}</div>`;

export function buildSignupReceivedEmail({ companyName, contactEmail }) {
  const company = escapeHtml(companyName);
  return {
    subject: 'We received your SuperRank request',
    html: emailShell({
      eyebrow: 'Request received',
      title: 'Thanks, we have your request',
      intro: `A person at SuperRank checks every new account before it opens, so <b>${company}</b> is not active yet. There is nothing you need to do.`,
      body: tint(`<b style="color:#171717">Next:</b> we email <b>${escapeHtml(contactEmail)}</b> as soon as it is approved, with a button to sign in. You sign in with the password you chose.`),
      footnote: 'Didn\'t ask for this? Ignore this email. Nothing is created until it is approved.',
    }),
  };
}

// The "Sign in" button opens the app's sign-in page with the address filled in; pressing Sign in there
// with the password they chose also confirms the address, so there is no separate confirm step.
export function buildSignupApprovedEmail({ companyName, contactEmail, signInUrl }) {
  const step = (n, text, last) => `<tr><td style="padding:0 10px ${last ? 0 : 7}px 0;color:${BRAND_ORANGE};font-weight:600;vertical-align:top">${n}</td><td style="padding-bottom:${last ? 0 : 7}px">${text}</td></tr>`;
  return {
    subject: 'Your SuperRank account is approved',
    html: emailShell({
      eyebrow: 'Account approved',
      title: `<span style="color:${BRAND_ORANGE}">Your account is approved.</span> Welcome.`,
      intro: `<b>${escapeHtml(companyName)}</b> is ready to set up. Sign in with <b>${escapeHtml(contactEmail)}</b> and the password you chose when you signed up.`,
      body: `<p style="margin:22px 0;text-align:center"><a href="${escapeHtml(signInUrl)}" style="${CARD_BUTTON}">Sign in</a></p>
     <div style="background:#fbfaf8;border-radius:10px;box-shadow:inset 0 0 0 1px #f0f0f0;padding:14px 16px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:500;color:#171717">What happens next</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;line-height:19px;color:#525252">
       ${step(1, 'Sign in. Your email is already filled in.')}${step(2, 'Name your workspace.')}${step(3, 'Add your first project, a website you want to grow.')}${step(4, 'Connect Google and GitHub. Your agent starts working.', true)}
      </table></div>`,
      footnote: `This link is for ${escapeHtml(contactEmail)} and expires in 7 days. Didn't ask for this account? Ignore this email and nothing is created.`,
    }),
  };
}

// The code is in the subject too, so a phone shows it without opening the message. No link on purpose:
// a link in a sign-in email is what phishing copies.
export function buildLoginCodeEmail({ email, code, minutes = 10, trial = false }) {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  return {
    subject: `Your SuperRank ${trial ? 'verification' : 'sign-in'} code: ${spaced}`,
    html: emailShell({
      eyebrow: trial ? 'Start your free trial' : 'Sign-in code',
      title: 'Here is your code',
      intro: trial ? 'Enter this code on the get-started page to confirm your email and start your free trial.' : 'Enter this code on the sign-in page to open your workspace.',
      body: `<div style="margin:22px 0;background:#fff4ed;border-radius:10px;box-shadow:inset 0 0 0 1px #ffe1cc;padding:18px;text-align:center;font-size:34px;letter-spacing:.32em;font-weight:600;color:#171717;font-family:ui-monospace,Menlo,monospace">${escapeHtml(code)}</div>
     <p style="margin:0;font-size:13px;line-height:19px;color:#525252">It works once and expires in <b>${minutes} minutes</b>. We sent it because someone ${trial ? 'asked to start a trial' : 'asked to sign in'} as <b>${escapeHtml(email)}</b>.</p>`,
      footnote: 'Didn\'t ask for this? Ignore this email, nobody can sign in without the code. Never share it. SuperRank staff will never ask for it.',
    }),
  };
}

export function buildSignupStaffNotice({ companyName, websiteDomain, contactEmail, message, reviewUrl, fullName, role, heardFrom }) {
  const row = (k, v) => (v ? `<tr><td style="padding:5px 14px 5px 0;color:#8a8a8a;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:5px 0;color:#171717">${v}</td></tr>` : '');
  return {
    subject: `New sign-up request: ${companyName}`,
    html: emailShell({
      eyebrow: 'New sign-up request',
      title: escapeHtml(companyName),
      intro: 'Someone asked for an account. Nothing is created until you approve it.',
      body: `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 0;font-size:13px;line-height:19px">
       ${row('Name', fullName ? escapeHtml(fullName) : '')}
       ${row('Email', `<a href="mailto:${escapeHtml(contactEmail)}" style="color:#171717">${escapeHtml(contactEmail)}</a>`)}
       ${row('Role', role ? escapeHtml(role) : '')}
       ${row('Website', websiteDomain ? escapeHtml(websiteDomain) : '')}
       ${row('Heard about us', heardFrom ? escapeHtml(heardFrom) : '')}
      </table>
      ${message ? `<div style="margin:16px 0 0;background:#fbfaf8;border-radius:10px;box-shadow:inset 0 0 0 1px #f0f0f0;padding:12px 14px;font-size:13px;line-height:19px;color:#525252;white-space:pre-wrap">${escapeHtml(message)}</div>` : ''}
      <p style="margin:22px 0 0;text-align:center"><a href="${escapeHtml(reviewUrl)}" style="${CARD_BUTTON}">Review the request</a></p>`,
      footnote: 'Approving creates their login only. They create their own workspace and projects once they sign in. Rejecting sends them nothing.',
    }),
  };
}

// A plain-text twin of the HTML. Mail that is HTML only, with no text part, is one of the things spam filters
// mark down; a real mail client shows the HTML and a filter sees both agree. Links keep their address.
export function plainTextOf(html) {
  return String(html)
    .replace(/<(style|head|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label.replace(/<[^>]+>/g, '').trim()} (${href})`)
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function sendBuilt({ to, built, exempt, label }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[email] SMTP not fully configured — skipping ${label}.`);
    return false;
  }
  await transporter.sendMail({
    ...(exempt ? { [REDIRECT_EXEMPT]: true } : {}),
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject: built.subject,
    html: built.html,
    text: plainTextOf(built.html),
  });
  console.log(`[email] ${label} sent to ${to}`);
  return true;
}

// To the person who asked: confirms the request and sets the expectation. Exempt
// from redirect mode because they asked for it (see REDIRECT_EXEMPT).
export const sendSignupReceivedEmail = (o) => sendBuilt({ to: o.contactEmail, built: buildSignupReceivedEmail(o), exempt: true, label: 'sign-up confirmation' });

// To the person whose request was approved: this is the "you can sign in" message.
export const sendSignupApprovedEmail = (o) => sendBuilt({ to: o.contactEmail, built: buildSignupApprovedEmail(o), exempt: true, label: 'sign-up approval' });

// The one-time sign-in code. Exempt from redirect mode: the person asked for it, and a redirected code
// would lock them out.
export const sendLoginCodeEmail = (o) => sendBuilt({ to: o.email, built: buildLoginCodeEmail(o), exempt: true, label: 'sign-in code' });

// To SuperRank staff: a request is waiting. Internal, so it is NOT exempt — redirect
// mode (a laptop, a staging box) must never send it to the real staff inbox.
export const sendSignupStaffNotice = (o) => sendBuilt({ to: LEADS_EMAIL_TO, built: buildSignupStaffNotice(o), exempt: false, label: 'sign-up staff notice' });

// server/notifications/channels/email.js — the email delivery channel for
// NotificationEvents (see server/notifications/types.js), including the
// Data Analyst Agent's predictive-risk alerts pushed via the
// push_predictive_alert MCP tool. Same per-site recipient convention as
// sendDailyEmail above (site.report_email_to, falling back to the global
// REPORT_EMAIL_TO), since these are genuinely per-site events, unlike the
// fixed internal LEADS_EMAIL_TO above.
export async function sendNotificationEmail(site, events) {
  const recipient = site.report_email_to || process.env.REPORT_EMAIL_TO;
  const transporter = getTransporter();
  if (!transporter || !recipient) {
    console.log('[email] SMTP not fully configured — skipping notification email.');
    return false;
  }
  if (!events.length) return false;

  const row = (e) => `
    <tr>
      <td style="padding:10px 14px;border:1px solid #eee">
        <div style="font-size:11px;text-transform:uppercase;color:${e.severity === 'high' ? '#c0392b' : '#888'}">${escapeHtml(e.severity)}</div>
        <div style="font-size:15px;font-weight:600;color:#111;margin:2px 0">${escapeHtml(e.title)}</div>
        <div style="font-size:13px;color:#555">${escapeHtml(e.body)}</div>
      </td>
    </tr>`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px">
    <h2 style="margin:0 0 4px">${escapeHtml(site.name)} — ${events.length} alert${events.length === 1 ? '' : 's'}</h2>
    <table style="border-collapse:collapse;width:100%">${events.map(row).join('')}</table>
    <p style="color:#999;font-size:12px;margin-top:16px">Automated alert. Open the dashboard for full detail.</p>
  </div>`;

  await transporter.sendMail({
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to: recipient,
    subject: `${site.name}: ${events.length} alert${events.length === 1 ? '' : 's'}`,
    html,
  });
  console.log(`[email] ${events.length} notification event(s) sent to ${recipient}`);
  return true;
}

// Free audit: the private report link, sent to the visitor who unlocked it.
// Returns false (and the page still shows the link) when SMTP is not configured.
export async function sendFreeAuditReportEmail({ to, host, reportUrl }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log('[email] SMTP not fully configured — skipping free audit report email.');
    return false;
  }
  await transporter.sendMail({
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject: `Your SuperRank audit for ${host}`,
    html: `<p>Your full audit for <b>${escapeHtml(host)}</b> is ready, with the fix for each issue.</p><p><a href="${escapeHtml(reportUrl)}">Open your report</a></p><p>The link is private to you and stays active for 30 days.</p>`,
  });
  return true;
}
