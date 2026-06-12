import nodemailer from 'nodemailer';

// Builds a small HTML morning email from the day's metrics + AI narrative.
// Skips silently (returns false) if SMTP is not configured, so the rest of the
// pipeline still succeeds.
export async function sendDailyEmail(site, reportDate, day, narrative) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REPORT_EMAIL_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !REPORT_EMAIL_TO) {
    console.log('[email] SMTP not fully configured — skipping email.');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE ?? 'true') === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

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
    from: process.env.REPORT_EMAIL_FROM || SMTP_USER,
    to: REPORT_EMAIL_TO,
    subject: `${site.name}: ${n(day?.clicks)} clicks, ${n(day?.users)} users — ${reportDate}`,
    html,
  });
  console.log(`[email] sent to ${REPORT_EMAIL_TO}`);
  return true;
}
