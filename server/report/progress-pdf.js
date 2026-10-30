import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STATUS } from './work-catalogue.js';

// The standard MONTHLY PROGRESS REPORT PDF, one design for every client:
// light, plain language, accent colour = the client's own brand colour (see
// brand-theme.js). It renders whatever `data` (progress-data.js) holds and
// leaves out, or says "not measured yet" for, anything that is missing; it
// never fills a gap with an invented figure.
//
// Pages (a page is dropped when there is nothing real to put on it):
//   cover · progress at a glance · AI-readiness checks · work completed ·
//   in progress and coming next · third-party listings · what's next
//
// PDF rendering itself is shared with the baseline report
// (renderBaselineReportPdf in baseline-pdf.js).

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO = `data:image/png;base64,${readFileSync(join(__dirname, 'assets/zunkireelabs-icon.png')).toString('base64')}`;

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => Number(n ?? 0).toLocaleString('en-US');
const e = escapeHtml;

const STATUS_PILL = { live: 'live', waiting: 'wait', google: 'wait', prog: 'prog', planned: 'next' };

function rootVars(t) {
  return `:root{--a:${t.accent};--at:${t.text};--soft:${t.soft};--bd:${t.border};--bar:${t.bar};--cover:${t.cover};--navy:#0f172a;--muted:#64748b;--faint:#94a3b8;--line:#e2e8f0;--surface:#f8f7f4;--ok:#15803d;--okbg:#ecfdf3}`;
}

const CSS = String.raw`
/*ROOT*/;--at:{T['at']};--soft:{T['soft']};--bd:{T['bd']};--bar:{T['bar']};--navy:#0f172a;--muted:#64748b;--faint:#94a3b8;--line:#e2e8f0;--surface:#f8f7f4;--ok:#15803d;--okbg:#ecfdf3}
*{box-sizing:border-box}html,body{margin:0;background:#cbd0d8}
body{font-family:'DM Sans',-apple-system,Helvetica,Arial,sans-serif;color:var(--navy);-webkit-font-smoothing:antialiased}
.page{width:794px;height:1123px;margin:24px auto;background:#fff;position:relative;overflow:hidden;padding:0 56px;display:flex;flex-direction:column}
.page:before{content:'';position:absolute;left:0;right:0;top:0;height:6px;background:var(--a)}
.hdr{display:flex;justify-content:space-between;align-items:center;padding:34px 0 14px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:12px}.brand img{width:26px;height:26px;border-radius:7px}
.hdr .m{text-align:right;font-size:9.5px;color:var(--faint);line-height:1.5}.hdr .m b{letter-spacing:.14em;color:var(--muted);font-weight:600;font-size:9px}
.ftr{margin-top:auto;padding:12px 0 22px;border-top:1px solid var(--line);display:flex;justify-content:space-between;font-size:9.5px;color:var(--faint)}.ftr b{color:var(--navy);font-weight:600}
.kicker{display:flex;gap:10px;align-items:center;margin:24px 0 8px;font-size:10.5px;letter-spacing:.14em;font-weight:700;text-transform:uppercase}
.kicker i{font-family:'DM Mono',monospace;font-style:normal;color:#fff;background:var(--at);border-radius:5px;padding:2px 7px;letter-spacing:.04em}
h2{font-size:28px;line-height:1.12;margin:0 0 10px;letter-spacing:-.02em;font-weight:700}
.lead{font-size:14px;line-height:1.6;color:var(--muted);margin:0 0 18px;max-width:600px}
.lbl{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--faint);margin:0 0 10px}
.mono{font-family:'DM Mono',monospace}
.badge{position:absolute;top:12px;right:12px;font-size:8.5px;background:#fff3cd;color:#8a6d00;padding:2px 7px;border-radius:4px;letter-spacing:.06em;z-index:9}
.pill{display:inline-block;font-size:8.5px;letter-spacing:.1em;font-weight:700;border-radius:20px;padding:3px 9px;white-space:nowrap}
.pill.live{background:var(--okbg);color:var(--ok)}.pill.prog{background:var(--soft);color:var(--at);border:1px solid var(--bd)}.pill.wait{background:#fffbeb;color:#b45309}.pill.next{background:#f1f5f9;color:var(--muted)}
.up{background:var(--okbg);color:var(--ok);font-size:10px;font-weight:700;border-radius:20px;padding:3px 9px}
/* cover */
.cover{background:linear-gradient(180deg,#fff 0%,#fff 50%,var(--soft) 100%);padding:0}
.cover:before{height:10px}
.c-top{padding:46px 56px 0;display:flex;justify-content:space-between;align-items:center}
.c-top img{width:84px;height:84px;border-radius:19px}.c-top span{font-size:10px;letter-spacing:.18em;color:var(--muted)}
.c-mid{padding:120px 56px 0;position:relative}
.c-mid h1{font-size:58px;line-height:1.02;letter-spacing:-.035em;margin:0 0 20px;font-weight:700;max-width:420px}.c-mid h1 em{font-style:normal;color:var(--at)}
.c-mid .for{font-size:16px;color:var(--muted);margin:0 0 4px}.c-mid .for b{color:var(--navy)}.c-mid .dt{font-size:10px;letter-spacing:.18em;color:var(--faint);margin:0}
.hero{position:absolute;right:56px;top:70px;width:230px;text-align:center}
.hero .g{position:relative;width:230px;height:230px}.hero .g svg{transform:rotate(-90deg)}
.hero .v{position:absolute;inset:0;display:grid;place-items:center}.hero .v b{font-size:68px;letter-spacing:-.04em;line-height:1}.hero .v small{display:block;font-size:11px;color:var(--faint);letter-spacing:.14em;text-transform:uppercase;margin-top:6px}
.hero .cap{margin-top:12px;font-size:10.5px;line-height:1.5;color:var(--muted)}.hero .cap b{color:var(--navy);font-size:12px}
.c-verdict{position:absolute;left:56px;right:56px;bottom:300px;font-size:20px;line-height:1.5;max-width:620px;margin:0}
.c-verdict b{background:linear-gradient(transparent 62%,var(--bar) 62%)}
.c-stats{position:absolute;left:56px;right:56px;bottom:100px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.sc{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px;border-top:3px solid var(--a)}
.sc .n{font-size:44px;font-weight:700;letter-spacing:-.03em;line-height:1}.sc .n small{font-size:15px;color:var(--faint);font-weight:500}
.sc .t{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:8px}.sc .s{font-size:11px;font-weight:700;letter-spacing:.08em;margin-top:6px;color:var(--ok)}
.c-foot{position:absolute;left:56px;right:56px;bottom:34px;font-size:10px;color:var(--faint);display:flex;justify-content:space-between}
/* p2 */
.dgrid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.dc{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:#fff;position:relative;overflow:hidden}
.dc:after{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--a)}
.dc .tl{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--faint)}
.dc .row{display:flex;align-items:baseline;gap:10px;margin:8px 0 6px}.dc .from{font-family:'DM Mono',monospace;font-size:17px;color:var(--faint)}.dc .ar{color:var(--at);font-weight:700}
.dc .to{font-size:40px;font-weight:700;letter-spacing:-.03em;line-height:1}.dc .to small{font-size:15px;color:var(--faint);font-weight:500}.dc .up{margin-left:auto}
.dc p{margin:0;font-size:11px;line-height:1.5;color:var(--muted)}
.summary{margin-top:16px;background:var(--soft);border:1px solid var(--bd);border-radius:14px;padding:15px 20px;font-size:12.5px;line-height:1.6}
.chart{border:1px solid var(--line);border-radius:14px;padding:14px 18px 10px;margin-top:16px}
.chart .ch{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.chart .lg{display:flex;gap:14px;font-size:10px;color:var(--muted)}.chart .lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.stab{border:1px solid var(--line);border-radius:12px;overflow:hidden}.stab table{width:100%;border-collapse:collapse;font-size:11px}.stab th{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);text-align:left;padding:8px 14px;background:var(--surface)}.stab td{padding:7px 14px;border-top:1px solid var(--line)}.stab .nm2{font-family:'DM Mono',monospace;font-size:10.5px;color:var(--muted)}.mile{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}
.mile div{font-size:10.5px;line-height:1.45;color:var(--muted);border-left:3px solid var(--bar);padding-left:10px}.mile b{display:block;color:var(--navy);font-size:11px}
/* p3 */
.sumrow{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:6px}
.sm{background:var(--soft);border:1px solid var(--bd);border-radius:12px;padding:12px 14px}.sm b{font-size:24px;letter-spacing:-.02em;display:block;line-height:1.1}.sm span{font-size:10.5px;color:var(--muted)}
.ck{display:grid;grid-template-columns:200px 1fr 92px;gap:16px;align-items:center;padding:11px 0;border-top:1px solid var(--line)}
.ck .nm{font-size:12.5px;font-weight:700}.ck .nm span{display:block;font-weight:400;font-size:10.5px;color:var(--muted);margin-top:2px;line-height:1.35}
.ck .bb{height:7px;border-radius:4px;background:#eef1f5;margin:3px 0;overflow:hidden}.ck .bb i{display:block;height:100%;border-radius:4px}
.ck .did{font-size:10.5px;color:var(--navy);margin-top:6px;line-height:1.4}.ck .did b{color:var(--at)}
.ck .vv{text-align:right}.ck .vv div{font-family:'DM Mono',monospace;font-size:12px}.ck .vv s{color:var(--faint);text-decoration:none}
.ck .vv em{display:inline-block;font-style:normal;font-size:8.5px;letter-spacing:.1em;font-weight:700;border-radius:20px;padding:2px 8px;margin-top:5px}
.t-up{background:var(--okbg);color:var(--ok)}.t-st{background:#f1f5f9;color:var(--muted)}.t-more{background:#fffbeb;color:#b45309}
.legend{display:flex;gap:16px;font-size:10px;color:var(--muted);margin:8px 0 0}.legend i{display:inline-block;width:14px;height:5px;border-radius:3px;margin-right:6px;vertical-align:middle}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}
.box{border:1px solid var(--line);border-radius:12px;padding:13px 16px}.box ul{margin:0;padding-left:15px;font-size:11px;line-height:1.55;color:var(--muted)}.box li{margin-bottom:3px}
/* p4 gantt */
.tally{display:flex;gap:10px;margin-bottom:4px}.tally div{flex:1;border:1px solid var(--line);border-radius:12px;padding:8px 14px;display:flex;align-items:center;gap:10px}.tally b{font-size:22px;letter-spacing:-.02em}.tally span{font-size:10px;color:var(--muted);line-height:1.2}
.axis{display:grid;grid-template-columns:1fr 150px;gap:12px;margin-top:6px}
.axis .ax{display:grid;grid-template-columns:44.4% 1fr auto;font-size:8.5px;color:var(--faint);letter-spacing:.06em;border-bottom:1px solid var(--line);padding-bottom:3px}
.grp{margin:8px 0 0;font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--at)}.grp small{font-weight:500;letter-spacing:0;text-transform:none;color:var(--muted);font-size:10.5px}
.wl{display:grid;grid-template-columns:78px 1fr 150px;gap:12px;padding:5px 0;border-top:1px solid var(--line);align-items:center}
.wl h5{margin:0 0 1px;font-size:11.8px}.wl p{margin:0;font-size:9.9px;line-height:1.4;color:var(--muted)}.wl p b{color:var(--navy);font-weight:600}
.gt{position:relative;height:10px;background:linear-gradient(90deg,#e2e8f0 1px,transparent 1px) 0 0/1px 100% no-repeat,linear-gradient(90deg,#e2e8f0 1px,transparent 1px) 44.4% 0/1px 100% no-repeat;border-radius:5px}
.gt i{position:absolute;top:1px;height:8px;border-radius:4px;background:var(--a)}.gt i.w{background:repeating-linear-gradient(45deg,#f59e0b 0 4px,#fcd34d 4px 8px)}.gt i.p{background:transparent;border:1.5px dashed var(--faint)}.gt i.f{background:var(--bar)}
.gt i.n{background:var(--a);width:8px!important;border-radius:50%;height:8px}
.key{display:flex;gap:14px;flex-wrap:wrap;font-size:9.5px;color:var(--muted);margin-top:8px}.key span{display:inline-flex;gap:6px;align-items:center}
/* p4/p5 cards */
.grp2{margin:18px 0 10px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--at)}.grp2 small{font-weight:500;letter-spacing:0;text-transform:none;color:var(--muted);font-size:10.5px}
.wgrid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.wc{border:1px solid var(--line);border-radius:14px;padding:14px 18px;background:#fff}.wc.big{padding:20px 22px}
.wh{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.wd{font-size:8.5px;letter-spacing:.14em;font-weight:700;color:var(--at)}
.wc h5{margin:0 0 6px;font-size:14px;line-height:1.25}.wt{margin:0 0 9px;font-size:11.3px;line-height:1.55;color:var(--navy)}
.wy{margin:0;font-size:10.5px;line-height:1.5;color:var(--muted);border-top:1px solid var(--line);padding-top:8px}.wy b{color:var(--navy);font-weight:600}.wy.nxt b{display:block;font-size:8.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-bottom:2px;font-weight:700}.wy.nxt{border-top:0;padding-top:0;margin-top:8px}.wc.span2{grid-column:1/3}
.tlbox{border:1px solid var(--line);border-radius:14px;padding:12px 18px}
.tax{display:grid;grid-template-columns:190px 1fr;gap:12px}.ax2{display:grid;grid-template-columns:44.4% 1fr auto;font-size:8.5px;color:var(--faint);letter-spacing:.06em;padding-bottom:4px;border-bottom:1px solid var(--line)}
.tr{display:grid;grid-template-columns:190px 1fr;gap:12px;align-items:center;padding:5px 0;font-size:10.5px;color:var(--navy)}
/* p5 */
.prev{margin-top:18px;background:var(--soft);border:1px solid var(--bd);border-left:4px solid var(--a);border-radius:14px;padding:16px 20px}.pv3{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.pv3 b{display:block;font-size:20px;letter-spacing:-.02em;margin-bottom:4px}.pv3 span{font-size:10.8px;line-height:1.5;color:var(--muted)}
.cards2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.lc{border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;gap:14px}.lc.wide{grid-column:1/3}
.lc .ic{width:42px;height:42px;border-radius:11px;background:var(--soft);border:1px solid var(--bd);color:var(--at);display:grid;place-items:center;font-weight:700;font-size:17px;flex:none}
.lc h5{margin:0 0 2px;font-size:13.5px}.lc .sub{font-size:10.5px;color:var(--muted);margin-bottom:8px}.lc p{margin:8px 0 0;font-size:10.8px;line-height:1.5;color:var(--muted)}
.nap{margin-top:16px;border:1px solid var(--bd);background:var(--soft);border-radius:14px;padding:16px 20px}
.nap .g{display:grid;grid-template-columns:repeat(2,1fr);gap:10px 24px;margin-top:6px}.nap .g div{font-size:11.5px}.nap .g span{display:block;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);font-weight:700;margin-bottom:2px}
.why{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 14px}.why div{background:var(--surface);border-radius:12px;padding:12px 14px;font-size:10.5px;line-height:1.5;color:var(--muted)}.why b{display:block;color:var(--navy);font-size:12px;margin-bottom:3px}
/* p6 */
.reads{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.rd{border:1px solid var(--line);border-radius:12px;padding:13px 15px;font-size:11px;line-height:1.55;color:var(--muted)}.rd b{display:block;color:var(--navy);font-size:12.5px;margin-bottom:3px}.rd.old{grid-column:1/4;background:var(--soft);border-color:var(--bd);border-left:4px solid var(--a)}
.next3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.nx{border:1px solid var(--bd);background:var(--soft);border-radius:12px;padding:13px 14px}.nx .no{font-family:'DM Mono',monospace;font-size:11px;color:var(--at);font-weight:700}.nx b{display:block;font-size:12.5px;margin:4px 0 3px}.nx span{font-size:10.5px;color:var(--muted);line-height:1.45}
.track{display:grid;grid-template-columns:repeat(4,1fr);gap:0;position:relative;margin-top:6px}.track:before{content:'';position:absolute;left:0;right:0;top:11px;height:3px;background:var(--line)}.track:after{content:'';position:absolute;left:0;width:34%;top:11px;height:3px;background:var(--a)}
.st{position:relative;padding-right:12px}.st .dot{width:25px;height:25px;border-radius:50%;background:#fff;border:2px solid var(--a);color:var(--at);display:grid;place-items:center;font-family:'DM Mono',monospace;font-size:9.5px;position:relative;z-index:1}.st.done .dot{background:var(--a);color:#fff}
.st .w{font-size:9.5px;letter-spacing:.12em;font-weight:700;margin:9px 0 3px;text-transform:uppercase}.st h6{margin:0 0 3px;font-size:12.5px}.st p{margin:0;font-size:10.5px;line-height:1.5;color:var(--muted)}
.close{margin-top:18px;background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--a);border-radius:12px;padding:16px 20px;display:flex;gap:16px;align-items:center}.close img{width:46px;height:46px;border-radius:11px}.close p{margin:0;font-size:12px;line-height:1.55;color:var(--muted)}.close p b{color:var(--navy)}
`;

const header = (d) => `<header class="hdr"><div class="brand"><img src="${LOGO}" alt="">Zunkiree Labs</div><div class="m"><b>MONTHLY PROGRESS REPORT</b><br>${e(d.siteName)} · ${e(d.dateLabel)}</div></header>`;
const footer = (n) => `<footer class="ftr"><span><b>Zunkiree Labs</b> — AI-Powered Website Growth</span><span>${n}</span></footer>`;
const section = (id, num_, kicker, title, lead, body, d, n) => `<section class="page" id="${id}">${header(d)}<div class="kicker"><i>${num_}</i> ${e(kicker)}</div><h2>${e(title)}</h2>${lead ? `<p class="lead">${lead}</p>` : ''}${body}${footer(n)}</section>`;

const lowTraffic = (d) => d.google && d.google.clicks <= 25;

function coverPage(d) {
  const ring = d.ai ? (() => {
    const R = 100; const C = 2 * Math.PI * R; const r2 = R - 22; const C2 = 2 * Math.PI * r2;
    return `<div class="hero"><div class="g"><svg width="230" height="230"><circle cx="115" cy="115" r="${R}" fill="none" stroke="#eef1f5" stroke-width="16"/><circle cx="115" cy="115" r="${R}" fill="none" stroke="var(--bar)" stroke-width="16" stroke-dasharray="${(C * d.ai.base / 100).toFixed(1)} ${C.toFixed(1)}"/><circle cx="115" cy="115" r="${r2}" fill="none" stroke="#eef1f5" stroke-width="16"/><circle cx="115" cy="115" r="${r2}" fill="none" stroke="var(--a)" stroke-width="16" stroke-linecap="round" stroke-dasharray="${(C2 * d.ai.now / 100).toFixed(1)} ${C.toFixed(1)}"/></svg><div class="v"><div><b>${d.ai.now}</b><small>out of 100</small></div></div></div><div class="cap"><b>Found by AI chat</b><br>Inner ring: today · Outer ring: starting report (${d.ai.base})</div></div>`;
  })() : '';
  const verdict = `${d.headline.lead}${d.headline.grew}.${lowTraffic(d) ? ` Visits from Google are still low, because new pages take time to rank${d.previousSite ? ' and Google is still clearing out your previous website' : ''}.` : ''}`;
  const card = (n, label, note, color) => `<div class="sc"><div class="n">${n}</div><div class="t">${label}</div><div class="s" style="color:${color || 'var(--ok)'}">${note}</div></div>`;
  const nm = 'var(--muted)';
  const stats = [
    d.ai ? card(`${d.ai.now}<small>/100</small>`, 'Found by AI chat', d.ai.now > d.ai.base ? `UP FROM ${d.ai.base}` : 'MEASURED THIS MONTH', d.ai.now > d.ai.base ? null : nm) : card('—', 'Found by AI chat', 'NOT MEASURED YET', nm),
    d.pages ? card(num(d.pages.now), 'Pages on your site', d.pages.base != null && d.pages.now > d.pages.base ? `UP FROM ${num(d.pages.base)}` : 'COUNTED THIS MONTH', d.pages.base != null && d.pages.now > d.pages.base ? null : nm) : card('—', 'Pages on your site', 'NOT MEASURED YET', nm),
    d.google ? card(num(d.google.clicks), 'Clicks from Google', `${num(d.google.impressions)} TIMES SHOWN`, nm) : card('—', 'Clicks from Google', 'NOT MEASURED YET', nm),
  ].join('');
  return `<section class="page cover" id="p1"><div class="c-top"><img src="${LOGO}" alt=""><span>ZUNKIREE LABS · AI-POWERED WEBSITE GROWTH</span></div><div class="c-mid"><h1>Monthly<br>Progress <em>Report</em></h1><p class="for">Prepared for <b>${e(d.siteName)}</b></p><p class="dt">${e(d.monthLabel).toUpperCase()} · SINCE YOUR STARTING REPORT</p>${ring}</div><p class="c-verdict">${verdict}</p><div class="c-stats">${stats}</div><div class="c-foot"><span>Prepared for ${e(d.siteName)}</span><span>${d.dataThrough ? `Google figures to ${e(d.dataThrough.replace(/, \d{4}$/, ''))} · from your Search Console` : 'Measured for your monthly report'}</span></div></section>`;
}

function glancePage(d, P) {
  const delta = (a, b) => (b - a >= 0 ? `+${num(b - a)}` : `${num(b - a)}`);
  const cards = [];
  if (d.ai) cards.push(`<div class="dc"><div class="tl">Found by AI chat</div><div class="row"><span class="from">${d.ai.base}</span><span class="ar">→</span><span class="to">${d.ai.now}<small>/100</small></span><span class="up">${delta(d.ai.base, d.ai.now)}</span></div><p>Since your starting report. How easily tools like ChatGPT can read your site.</p></div>`);
  if (d.pages?.base != null) cards.push(`<div class="dc"><div class="tl">Pages on your website</div><div class="row"><span class="from">${num(d.pages.base)}</span><span class="ar">→</span><span class="to">${num(d.pages.now)}</span><span class="up">${delta(d.pages.base, d.pages.now)}</span></div><p>Since your starting report. Pages for customers, Google and AI tools to find.</p></div>`);
  else if (d.pages) cards.push(`<div class="dc"><div class="tl">Pages on your website</div><div class="row"><span class="to">${num(d.pages.now)}</span></div><p>Pages for customers, Google and AI tools to find.</p></div>`);
  const since = d.dataThrough ? `Total since Google began recording your site, to ${e(d.dataThrough.replace(/, \d{4}$/, ''))}.` : '';
  if (d.google) {
    cards.push(`<div class="dc"><div class="tl">Times you appeared on Google</div><div class="row"><span class="to">${num(d.google.impressions)}</span></div><p>${since}</p></div>`);
    cards.push(`<div class="dc"><div class="tl">Clicks from Google</div><div class="row"><span class="to">${num(d.google.clicks)}</span></div><p>${since}</p></div>`);
  } else cards.push(`<div class="dc"><div class="tl">Google visibility</div><div class="row"><span class="to">—</span></div><p>Not measured yet. Connect Google Search Console to see how often you appear.</p></div>`);

  const summary = `<div class="summary"><b>In short:</b> ${d.ai && d.ai.now > d.ai.base ? 'your site is now far easier for Google and AI to understand' : 'here is where your site stands today'}${d.pages?.base != null && d.pages.now > d.pages.base ? ' and much bigger' : ''}.${lowTraffic(d) ? ` Visits from Google are still small. New pages take weeks to months to rank${d.previousSite ? `, and Google is still clearing out old pages left by your previous website (see pages ${P.progressNext.join(' and ')})` : ''}.` : ''}</div>`;

  let chart = '';
  if (d.weekly.length >= 2) {
    const W = 640; const H = 150; const px = 40; const step = (W - px) / d.weekly.length; const bw = Math.min(38, step - 10);
    const maxv = Math.max(...d.weekly.map((w) => w.impressions), 1);
    const mx = Math.max(25, Math.ceil(maxv / 25) * 25);
    const y = (v) => H - (v / mx) * H * 0.9;
    const grid = [0, mx / 2, mx].map((v) => `<line x1="${px}" x2="${W}" y1="${y(v).toFixed(0)}" y2="${y(v).toFixed(0)}" stroke="#eef1f5"/><text x="${px - 8}" y="${(y(v) + 3).toFixed(0)}" font-size="9" fill="#94a3b8" text-anchor="end">${Math.round(v)}</text>`).join('');
    const bars = d.weekly.map((w, i) => {
      const cx = px + i * step + step / 2;
      return `<rect x="${(cx - bw / 2).toFixed(0)}" y="${y(w.impressions).toFixed(0)}" width="${bw.toFixed(0)}" height="${(H - y(w.impressions)).toFixed(0)}" rx="4" fill="var(--bar)"/><text x="${cx.toFixed(0)}" y="${(y(w.impressions) - 5).toFixed(0)}" font-size="9.5" fill="#0f172a" text-anchor="middle" font-family="DM Mono">${w.impressions}</text><text x="${cx.toFixed(0)}" y="${H + 14}" font-size="9" fill="#94a3b8" text-anchor="middle">${e(w.label)}</text><text x="${cx.toFixed(0)}" y="${H + 34}" font-size="10" fill="${w.clicks ? 'var(--at)' : '#cbd5e1'}" text-anchor="middle" font-family="DM Mono" font-weight="${w.clicks ? 700 : 400}">${w.clicks}</text>`;
    }).join('');
    chart = `<div class="chart"><div class="ch"><span class="lbl" style="margin:0">Week by week — times you appeared on Google</span></div><svg width="${W}" height="${H + 42}" viewBox="0 0 ${W} ${H + 42}" style="display:block;margin:6px auto 0">${grid}${bars}<text x="${px - 8}" y="${H + 34}" font-size="9" fill="#94a3b8" text-anchor="end">clicks</text></svg></div>`;
  }
  const searches = d.searches.length ? `<p class="lbl" style="margin:16px 0 8px">What people searched for that matches your business</p><div class="stab"><table><tr><th>Search</th><th>Times shown</th><th>Where you appeared</th></tr>${d.searches.map((s) => `<tr><td>${e(s.query)}</td><td class="nm2">${s.impressions}</td><td class="nm2">Google page ${s.page}</td></tr>`).join('')}</table></div>` : '';
  return section('p2', '01', 'Progress at a glance', 'Where your site stands now', 'Where your site stands today, and how far it has come since your starting report.', `<div class="dgrid">${cards.join('')}</div>${summary}${chart}${searches}`, d, P.glance);
}

function checksPage(d, P) {
  const up = d.checks.filter((c) => c.tag === 'IMPROVED').length;
  const steady = d.checks.filter((c) => c.tag === 'STEADY').length;
  const more = d.checks.filter((c) => c.tag === 'NEEDS MORE WORK');
  const cls = { IMPROVED: 't-up', STEADY: 't-st', 'NEEDS MORE WORK': 't-more' };
  const rows = d.checks.map((c) => `<div class="ck"><div class="nm">${e(c.name)}<span>${e(c.sub)}</span></div><div><div class="bb"><i style="width:${Math.max(1, c.base)}%;background:#cbd5e1"></i></div><div class="bb"><i style="width:${Math.max(1, c.now)}%;background:var(--a)"></i></div>${c.did ? `<div class="did"><b>What we did:</b> ${e(c.did)}</div>` : ''}</div><div class="vv"><div><s>${c.base}</s> → <b>${c.now}</b></div><em class="${cls[c.tag]}">${c.tag}</em></div></div>`).join('');
  const sum = `<div class="sumrow"><div class="sm"><b>${up}</b><span>check${up === 1 ? '' : 's'} improved</span></div><div class="sm"><b>${steady}</b><span>held steady</span></div><div class="sm"><b>${more.length}</b><span>${more.length ? `need${more.length === 1 ? 's' : ''} more work — ${e(more.map((m) => m.name).join(', '))}` : 'need more work'}</span></div></div>`;
  return section('p3', '02', 'Then vs today', 'How readable your site is to AI, check by check', `We check the same ${d.checks.length === 7 ? 'seven' : d.checks.length} things every month.`, `${sum}${rows}<div class="legend"><span><i style="background:#cbd5e1"></i>Starting report</span><span><i style="background:var(--a)"></i>Today</span></div><div class="two"><div class="box"><p class="lbl">Why this matters</p><ul><li>AI tools only recommend businesses they can read and trust.</li><li>Every check you pass makes that more likely.</li></ul></div><div class="box"><p class="lbl">Check it yourself</p><ul><li>Page labels: Google’s Rich Results Test</li><li>Visits and clicks: Google Search Console and Google Analytics</li></ul></div></div>`, d, P.checks);
}

const workCard = (i, wide, withNext) => `<div class="wc${wide ? ' span2' : ''}${withNext ? ' big' : ''}"><div class="wh"><span class="pill ${STATUS_PILL[i.status]}">${STATUS[i.status].label}</span>${withNext ? '' : `<span class="wd">${e(i.group.toUpperCase())}</span>`}</div><h5>${e(i.title)}</h5><p class="wt">${e(i.did)}</p><p class="wy"><b>Why it matters:</b> ${e(i.why)}</p>${withNext && i.next ? `<p class="wy nxt"><b>What happens next</b>${e(i.next)}</p>` : ''}</div>`;

function completedPage(d, P) {
  const live = d.work.filter((w) => w.status === 'live');
  const cards = live.map((w, i) => workCard(w, live.length % 2 === 1 && i === live.length - 1, false)).join('');
  const body = live.length ? `<div class="wgrid" style="margin-top:6px">${cards}</div>` : '<div class="summary">Your completed work will appear here as it goes live.</div>';
  return section('p4', '03', 'Work completed', live.length ? `${live.length} piece${live.length === 1 ? '' : 's'} of work ${live.length === 1 ? 'is' : 'are'} live on your site` : 'Work completed', 'Everything we have finished since your starting report. Each one is live on your website.', body, d, P.completed);
}

function progressPage(d, P) {
  const rest = d.work.filter((w) => w.status !== 'live');
  const cards = rest.map((w) => workCard({ ...w, next: w.next || (w.status === 'planned' ? 'We start next month.' : w.status === 'prog' ? 'We keep going until it is done.' : null) }, false, true)).join('');
  const ps = d.previousSite;
  const prev = ps ? `<div class="prev"><p class="lbl" style="margin:0 0 8px">Why your numbers are held back: your previous website</p><div class="pv3">${ps.pagesInTen ? `<div><b>About ${ps.pagesInTen} in 10</b><span>of the pages Google showed were old, unrelated pages left by your previous website.</span></div>` : ''}${ps.unrelatedSearches ? `<div><b>${ps.unrelatedSearches} of ${ps.totalSearches}</b><span>of the searches Google lets us see were not about your business at all.</span></div>` : ''}<div><b>Slow by design</b><span>Google decides when to clear old pages. It is not something we can speed up.</span></div></div></div>` : '';
  return section('p5', '04', 'In progress and coming next', 'What we are still working on', `${rest.length ? `${rest.length === 1 ? 'One piece' : `${['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'][rest.length] || rest.length} pieces`} of work ${rest.length === 1 ? 'is' : 'are'} not finished yet. Here is where each stands.` : 'Nothing is waiting right now.'}`, `${rest.length ? `<div class="wgrid" style="margin-top:6px">${cards}</div>` : ''}${prev}`, d, P.progress);
}

function listingsPage(d, P) {
  const initial = (n) => e(String(n).trim()[0]?.toUpperCase() || '·');
  const cards = d.listings.map((l, i) => `<div class="lc${d.listings.length % 2 === 1 && i === d.listings.length - 1 ? ' wide' : ''}"><div class="ic">${initial(l.name)}</div><div><h5>${e(l.name)}</h5><div class="sub">${e(l.kind)}</div><span class="pill ${l.status === 'live' ? 'live' : 'next'}">${l.status === 'live' ? 'LIVE' : 'LISTED'}</span><p>${l.status === 'live' ? `Shows ${e(d.nap?.name || d.siteName)}.` : 'Linked from your website. We could not open the page automatically.'}</p></div></div>`).join('');
  const nap = d.nap ? `<div class="nap"><p class="lbl" style="margin:0">The details every listing should match</p><div class="g"><div><span>Business name</span>${e(d.nap.name)}</div>${d.nap.phone ? `<div><span>Phone</span>${e(d.nap.phone)}</div>` : ''}${d.nap.address ? `<div><span>Address</span>${e(d.nap.address)}</div>` : ''}</div></div>` : '';
  return section('p6', '05', 'Third-party listings', 'Where else your business is listed online', `Google and AI tools trust a business more when its details appear on other well-known websites. Your website links to ${d.listings.length === 1 ? 'this listing' : `these ${d.listings.length}`}.`, `<div class="why"><div><b>Trust</b>Other sites vouching for you tells AI you are real.</div><div><b>Consistency</b>The same name, address and phone everywhere.</div><div><b>New customers</b>People find you on sites they already use.</div></div><div class="cards2">${cards}</div>${nap}<div class="key" style="margin-top:14px"><span><span class="pill live">LIVE</span> we opened the page and it shows your business</span><span><span class="pill next">LISTED</span> linked from your site; we could not open the page</span></div><p style="font-size:11px;color:var(--muted);margin:12px 0 0">Every month we check that your name, address and phone still match your website.</p>`, d, P.listings);
}

function nextPage(d, P) {
  const reads = [];
  if (lowTraffic(d)) reads.push(`<div class="rd"><b>Early days</b>${num(d.google.impressions)} appearances and ${num(d.google.clicks)} click${d.google.clicks === 1 ? '' : 's'} are small numbers. We report them as they are.</div>`);
  reads.push('<div class="rd"><b>New pages take time</b>Google usually takes weeks to months to rank new pages, so the full effect of recent work is still ahead.</div>');
  if (d.ai) reads.push('<div class="rd"><b>The AI score, explained</b>It measures how ready your site is to be mentioned by AI tools. It does not yet show them recommending you by name. We will report that when we can measure it.</div>');
  const prev = d.previousSite ? `<div class="rd old"><b>Your previous website is still being cleared</b>Before we began, the previous website left many outdated and unrelated pages in Google, and these cause problems.${d.previousSite.pagesInTen ? ` About ${d.previousSite.pagesInTen} in 10 of the pages Google showed were of this kind.` : ''} Google decides how quickly it clears them, so this is slow and not something we can speed up. It will clear over time, and these pages will gradually drop out of your results.</div>` : '';

  const planned = d.work.filter((w) => w.status === 'planned' || w.status === 'prog' || w.status === 'waiting').slice(0, 3).map((w) => (w.status === 'waiting' ? { t: `Confirm “${w.title}” is live`, s: 'The final go-live of the work that is waiting.' } : { t: w.title, s: w.did }));
  const weakest = [...d.checks].filter((c) => c.tag === 'NEEDS MORE WORK').sort((a, b) => a.now - b.now)[0];
  if (weakest && planned.length < 3) planned.push({ t: `Strengthen “${weakest.name}”`, s: `Move it above ${weakest.now} out of 100.` });
  const nextCards = planned.length ? `<p class="lbl" style="margin-top:22px">Planned for next month</p><div class="next3">${planned.map((p, i) => `<div class="nx"><span class="no">0${i + 1}</span><b>${e(p.t)}</b><span>${e(p.s)}</span></div>`).join('')}</div>` : '';

  const has = (g, f) => d.work.some((w) => w.group === g && f(w));
  const stage = (done, doing) => (done ? 'done' : doing ? 'prog' : 'next');
  const foundation = stage(has('Foundation', (w) => w.status === 'live') && !has('Foundation', (w) => w.status !== 'live'), has('Foundation', () => true));
  const content = stage(has('Content', (w) => w.status === 'live') && !has('Content', (w) => w.status !== 'live'), has('Content', () => true));
  const trust = d.listings.length ? 'prog' : 'next';
  const L = { done: ['DONE', 'var(--ok)'], prog: ['IN PROGRESS', 'var(--at)'], next: ['NEXT', 'var(--faint)'] };
  const st = (n, key, title, copy) => `<div class="st${key === 'done' ? ' done' : ''}"><div class="dot">${key === 'done' ? '✓' : `0${n}`}</div><div class="w" style="color:${L[key][1]}">${L[key][0]}</div><h6>${title}</h6><p>${copy}</p></div>`;
  const track = `<p class="lbl" style="margin-top:22px">Where we are on the roadmap</p><div class="track">${st(1, foundation, 'Foundation', 'Google and AI can find and read your site.')}${st(2, content, 'Content', 'Pages and articles that answer what customers search.')}${st(3, trust, 'Trust', 'Listings, mentions and trust signals.')}<div class="st"><div class="dot">04</div><div class="w" style="color:var(--navy)">ONGOING</div><h6>Measurement</h6><p>We measure again every month against your starting report.</p></div></div>`;
  const close = `<div class="close"><img src="${LOGO}" alt=""><p><b>Check any number yourself.</b> Every figure in this report can be checked in Google Search Console and Google Analytics. Next month we measure again against the same starting point.${d.dataThrough ? ` Google figures run to ${e(d.dataThrough.replace(/, \d{4}$/, ''))}.` : ''}</p></div>`;
  return section('p7', `0${P.nextNum}`, 'What’s next', 'How to read these numbers, and what comes next', 'We report your numbers exactly as they are. Here is what they mean.', `<div class="reads">${reads.join('')}${prev}</div>${nextCards}${track}${close}`, d, P.next);
}

// Which pages exist, in order, and their page numbers (for cross-references).
export function planPages(d) {
  const keys = ['cover', 'glance'];
  if (d.checks.length) keys.push('checks');
  keys.push('completed');
  if (d.work.some((w) => w.status !== 'live') || d.previousSite) keys.push('progress');
  if (d.listings.length) keys.push('listings');
  keys.push('next');
  const P = {}; keys.forEach((k, i) => { P[k] = i + 1; });
  P.nextNum = keys.length - 1;
  P.progressNext = [P.progress, P.next].filter(Boolean);
  return { keys, P };
}

export function renderProgressReportHtml(d) {
  const data = { checks: [], work: [], listings: [], weekly: [], searches: [], previousSite: null, nap: null, headline: { lead: '<b>Here is where your website stands</b>', grew: '' }, ...d };
  data.monthLabel = data.monthLabel || new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const { keys, P } = planPages(data);
  const render = { cover: coverPage, glance: glancePage, checks: checksPage, completed: completedPage, progress: progressPage, listings: listingsPage, next: nextPage };
  const pages = keys.map((k) => render[k](data, P)).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(data.siteName)} — Monthly Progress Report</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap" rel="stylesheet"><style>${CSS.replace('/*ROOT*/', rootVars(data.theme))}
@page{size:A4;margin:0}html,body{background:#fff!important}.page{margin:0!important;width:210mm!important;height:296.6mm!important;break-after:page;page-break-after:always}.page:last-child{break-after:auto;page-break-after:auto}.cover{background:linear-gradient(180deg,#fff 0%,#fff 50%,var(--cover) 100%)}</style></head><body>${pages}</body></html>`;
}
