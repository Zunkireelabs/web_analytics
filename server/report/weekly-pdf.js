// The weekly report as a PDF, in the same light design as the baseline and monthly PDFs (this file only adds two
// page layouts; the page frame, fonts and the client's colour come from baseline-pdf.js and brand-theme.js).
// Every figure comes from buildInAppModel, so the PDF, the dashboard page and the Google Doc agree.
import { marked } from 'marked';
import { reportCss, brandMark, footer, escapeHtml } from './baseline-pdf.js';
import { deriveBrandTheme, accentFromSite } from './brand-theme.js';

const e = escapeHtml;
const toneColor = (t) => (t === 'good' ? '#15803d' : t === 'bad' ? '#b42318' : null);
const cell = (c) => (c && typeof c === 'object' ? { text: c.t, color: toneColor(c.tone) } : { text: c, color: null });

const header = (siteName, periodLabel) => `<header class="hdr">${brandMark(24, 12)}<div class="hdr-meta"><b>WEEKLY REPORT</b><br>${e(siteName)} · ${e(periodLabel)}</div></header>`;
const frame = ({ id, num, kicker, title, lead, body, siteName, periodLabel, pageNumber }) => `
  <section class="page" id="${id}">${header(siteName, periodLabel)}
    <div class="kicker"><i>${num}</i> ${e(kicker)}</div><h2>${e(title)}</h2>${lead ? `<p class="lead">${e(lead)}</p>` : ''}${body}${footer(pageNumber)}
  </section>`;

const tile = (t) => `<div class="wk-tile"><p class="lbl">${e(t.label)}</p><div class="wk-val">${e(t.value)}</div>${t.delta?.trim() ? `<div class="wk-delta" style="color:${toneColor(t.tone) || 'var(--muted)'}">${e(t.delta)}</div>` : ''}</div>`;

const td = (c, i) => { const v = cell(c); const st = [i ? 'text-align:right' : '', v.color ? `color:${v.color};font-weight:700` : ''].filter(Boolean).join(';'); return `<td${st ? ` style="${st}"` : ''}>${e(v.text)}</td>`; };
const table = (s) => `<p class="lbl lbl-gap">${e(s.title)}</p><div class="panel"><table><tr>${s.head.map((h, i) => `<th${i ? ' style="text-align:right"' : ''}>${e(h)}</th>`).join('')}</tr>${s.rows.map((r) => `<tr>${r.map(td).join('')}</tr>`).join('')}</table></div>`;

const didList = (did) => `<div class="wk-did">${did.map((d) => `<div class="wk-item"><span class="wk-tick">✓</span><div><h3>${e(d.title)}</h3><p>${e(d.did)} <span>${e(d.why)}</span></p></div></div>`).join('')}</div>`;

// data: { site: {name,...}, periodLabel, body (buildInAppModel), summary (plain narrative or null) }
export function renderWeeklyReportHtml({ site, periodLabel, body, summary }) {
  const theme = deriveBrandTheme(accentFromSite(site));
  const day = body.sections[0];
  const rest = body.sections.slice(1);
  const summaryHtml = summary ? marked.parse(String(summary)) : '';
  const p1 = frame({
    id: 'w1', num: '01', kicker: 'This week at a glance', title: body.headline, siteName: site.name, periodLabel, pageNumber: 1,
    lead: `This is how ${site.name} did in search over ${periodLabel}, what we did to help, and how far the site has come since your baseline.`,
    body: `<div class="wk-tiles">${body.tiles.map(tile).join('')}</div>${summaryHtml ? `<div class="wk-sum">${summaryHtml}</div>` : ''}${table(day)}`,
  });
  const p2Body = `${body.did?.length ? `<p class="lbl">What we did this week</p>${didList(body.did)}` : '<p class="note">Nothing went live this week. We keep checking your site every day and will list each fix here as it ships.</p>'}${rest.slice(0, 2).map(table).join('')}`;
  const p2 = frame({ id: 'w2', num: '02', kicker: 'What we did and how far you have come', title: 'Progress since your baseline', siteName: site.name, periodLabel, pageNumber: 2, body: p2Body });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(site.name)} — Weekly Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap" rel="stylesheet">
<style>${reportCss(theme)}
  .wk-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 6px 0 16px; }
  .wk-tile { border: 1px solid ${theme.border}; background: ${theme.soft}; border-radius: 10px; padding: 12px 12px 10px; }
  .wk-tile .lbl { margin: 0 0 4px; }
  .wk-val { font-size: 26px; font-weight: 700; letter-spacing: -.03em; color: ${theme.text}; line-height: 1.1; }
  .wk-delta { font-size: 10.5px; font-weight: 700; margin-top: 4px; }
  .wk-sum { font-size: 12px; line-height: 1.6; color: var(--muted); margin: 0 0 6px; } .wk-sum p { margin: 0 0 6px; }
  .wk-did { display: grid; gap: 10px; margin-bottom: 6px; }
  .wk-item { display: flex; gap: 11px; border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px; }
  .wk-tick { width: 18px; height: 18px; border-radius: 50%; background: ${theme.soft}; color: ${theme.text}; font-size: 10px; font-weight: 800; display: grid; place-items: center; flex: none; margin-top: 1px; }
  .wk-item h3 { margin: 0 0 2px; font-size: 13px; } .wk-item p { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--muted); } .wk-item p span { color: var(--faint); }
</style></head><body>${p1}${p2}</body></html>`;
}
