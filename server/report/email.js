import nodemailer from 'nodemailer';

// Shared by every email sender below — null if SMTP isn't configured, so
// each caller can skip silently rather than throw.
function getTransporter() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE ?? 'true') === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
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
function escapeHtml(str) {
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
