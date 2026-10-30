// Real pictures of the Content options: each option (a landing page layout, a translation, a blog post) drawn with the
// SITE'S OWN look instead of a generic sketch, so two options differ the way they will on the page. The look is the
// computed style the site's design profile recorded for its real headings, body text and buttons (font, size, weight,
// colour, line height), with the site's own web fonts loaded and its brand colour on the buttons. Only the arrangement
// (grids, gaps) is ours, and the copy is sample wording. Shown in a script-less sandboxed frame; nothing here runs.
import { accentOf, normalizeHex, onColor } from '../report/brand.js';

const ORIGIN_TTL = 6 * 3600 * 1000;
const cache = new Map(); // origin -> { at, hrefs }

const originOf = (site) => {
  const raw = String(site?.website_domain || '').trim();
  if (!raw) return null;
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin; } catch { return null; }
};

// The site's stylesheet links, read from its public home page. Cached; a slow or failing site just means an unstyled
// preview, never an error.
export async function getSiteStylesheets(site, fetchImpl = fetch) {
  const origin = originOf(site);
  if (!origin) return { origin: null, hrefs: [] };
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < ORIGIN_TTL) return { origin, hrefs: hit.hrefs };
  let hrefs = [];
  try {
    const res = await fetchImpl(origin, { signal: AbortSignal.timeout(4000), redirect: 'follow', headers: { 'user-agent': 'SuperRank-preview' } });
    const html = res.ok ? await res.text() : '';
    hrefs = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0])
      .filter((tag) => /rel=["']?stylesheet/i.test(tag))
      .map((tag) => /href=["']([^"']+)["']/i.exec(tag)?.[1])
      .filter(Boolean)
      .filter((h) => /fonts\.googleapis\.com/.test(h)) // the site's web fonts; its utility CSS is not served as a file
      .map((h) => { try { return new URL(h, origin).href; } catch { return null; } })
      .filter((h) => h && h.startsWith('http'));
  } catch { hrefs = []; }
  cache.set(origin, { at: Date.now(), hrefs });
  return { origin, hrefs };
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const GRAY = { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 600: '#4b5563', 900: '#111827' };
// 'border-gray-200' -> '#e5e7eb'; anything else falls back.
const grayOf = (cls, fallback) => { const m = /gray-(\d+)/.exec(String(cls || '')); return (m && GRAY[m[1]]) || fallback; };

// One element's recorded computed style as inline CSS (only safe properties, values stripped of anything that could
// break out of the attribute).
const safe = (v) => String(v ?? '').replace(/[^\w\s.,%#()"'\-]/g, '').replace(/"/g, "'");
function inlineStyle(st, fallback) {
  const o = { ...fallback, ...(st ? { color: st.color, 'font-size': st.fontSize, 'font-family': st.fontFamily, 'font-weight': st.fontWeight, 'line-height': st.lineHeight, 'letter-spacing': st.letterSpacing } : {}) };
  return Object.entries(o).filter(([, v]) => v && v !== 'normal').map(([k, v]) => `${k}:${safe(v)}`).join(';');
}

// The site's real type and colours, from its design profile (anything missing falls back to a plain neutral value).
export function designKitFor(site) {
  const dp = site?.url_file_map?.siteRoot?.designProfile || {};
  const texts = (dp.pages || []).flatMap((pg) => (pg.sections || []).flatMap((sec) => sec.textHierarchy || []));
  const styleOf = (pred) => texts.find((t) => t.style && pred(t))?.style;
  const h1 = styleOf((t) => t.tag === 'h1');
  const body = styleOf((t) => t.tag === 'p' && t.role === 'body') || styleOf((t) => t.role === 'body');
  const font = h1?.fontFamily || body?.fontFamily || FONT;
  const brand = accentOf(site) || normalizeHex('#171717');
  return {
    h1: inlineStyle(h1, { 'font-family': font, 'font-size': '56px', 'line-height': '1.1', 'font-weight': '400', color: '#111827' }),
    h2: inlineStyle(styleOf((t) => t.tag === 'h2'), { 'font-family': font, 'font-size': '34px', 'line-height': '1.2', 'font-weight': '400', color: '#111827' }),
    h3: inlineStyle(styleOf((t) => t.tag === 'h3'), { 'font-family': font, 'font-size': '22px', 'line-height': '1.3', 'font-weight': '400', color: '#111827' }),
    body: inlineStyle(body, { 'font-family': font, 'font-size': '19px', 'line-height': '1.6', color: '#4b5563' }),
    font,
    brand, onBrand: onColor(brand),
    border: grayOf(dp.color?.border, GRAY[200]), surface: grayOf(dp.color?.surface, GRAY[50]),
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LAYOUT_CSS = `*{box-sizing:border-box}body{margin:0;background:#fff}.pv{max-width:1000px;margin:0 auto;padding:44px 32px}
.pv-grid{display:grid;gap:18px}.pv-3{grid-template-columns:repeat(3,1fr)}.pv-2{grid-template-columns:repeat(2,1fr)}.pv-card{border:1px solid;padding:22px}
.pv-field{border:1px solid #d1d5db;background:#fff;height:44px;margin-bottom:12px;padding:0 12px;display:flex;align-items:center;color:#9ca3af;font-size:15px}
.pv-form{border:1px solid #e5e7eb;padding:24px}.pv-quote{border-left:3px solid;padding-left:18px}p{margin:0}h1,h2,h3{margin:0}`;

const btn = (k, text) => `<span style="display:inline-flex;align-items:center;justify-content:center;padding:14px 28px;background:${k.brand};color:${k.onBrand};font:500 16px ${safe(k.font)}">${esc(text)}</span>`;
const card = (k, title, text) => `<div class="pv-card" style="border-color:${k.border};background:${k.surface}"><h3 style="${k.h3};font-size:20px;margin-bottom:8px">${esc(title)}</h3><p style="${k.body};font-size:15px;line-height:23px">${esc(text)}</p></div>`;
const h1 = (k, t) => `<h1 style="${k.h1};margin-bottom:16px">${esc(t)}</h1>`;
const h2 = (k, t) => `<h2 style="${k.h2};font-size:28px;margin-bottom:10px">${esc(t)}</h2>`;
const p = (k, t) => `<p style="${k.body};margin-bottom:18px">${esc(t)}</p>`;

export function renderOption(generatorId, optionKey, k, name = 'Your business') {
  const benefits = [['Clear answers', 'Plain wording that says what you do and who it is for.'], ['Found in search', 'Built for the searches your customers already make.'], ['Easy to act on', 'One obvious next step on every screen.']];
  let body = '';
  if (generatorId === 'landing-page') {
    if (optionKey === 'A') body = `${h1(k, `${name}, explained clearly`)}${p(k, 'What we do, who it is for, and how it works.')}<div style="margin-bottom:28px">${btn(k, 'Get started')}</div><div class="pv-grid pv-3">${benefits.map(([t, x]) => card(k, t, x)).join('')}</div>`;
    else if (optionKey === 'B') body = `<div class="pv-grid pv-2" style="align-items:center"><div>${h1(k, 'Talk to us today')}${p(k, 'Tell us what you need and we will reply the same day.')}</div><div class="pv-form"><div class="pv-field">Your name</div><div class="pv-field">Your email</div>${btn(k, 'Send enquiry')}</div></div><div class="pv-grid pv-3" style="margin-top:28px">${benefits.map(([t, x]) => card(k, t, x)).join('')}</div>`;
    else body = `${h1(k, 'What our clients say')}<div class="pv-grid pv-2" style="margin:24px 0 28px">${[['“They made our site easy to find.”', 'Client one'], ['“Clear, fast and honest work.”', 'Client two']].map(([q, a]) => `<div class="pv-quote" style="border-color:${k.brand}"><h3 style="${k.h3};font-size:21px;line-height:29px;margin-bottom:8px">${esc(q)}</h3><p style="${k.body};font-size:14px">${esc(a)}</p></div>`).join('')}</div>${btn(k, 'Start your project')}`;
  } else if (generatorId === 'translation') {
    // The same page in another language; languages run longer or shorter than English, which is the whole choice.
    if (optionKey === 'A') body = `${h1(k, 'Infraestructura de IA, construida correctamente')}${p(k, 'Construimos sistemas de IA de nivel de infraestructura para empresas modernas.')}${btn(k, 'Explorar nuestros productos')}`;
    else if (optionKey === 'B') body = `${h1(k, 'Infraestructura de inteligencia artificial, construida correctamente desde el primer día')}${p(k, 'Construimos sistemas de inteligencia artificial de nivel de infraestructura para empresas modernas.')}${btn(k, 'Explorar todos nuestros productos y servicios')}`;
    else body = `${h1(k, 'IA bien construida')}${p(k, 'Sistemas de IA para empresas modernas.')}${btn(k, 'Ver productos')}`;
  } else if (generatorId === 'blog-outline') {
    const sec = (t) => `${h2(k, t)}${p(k, 'A short, useful paragraph that answers the point directly and links to the next step.')}`;
    if (optionKey === 'A') body = `${h1(k, 'A complete guide to getting found online')}${p(k, 'An introduction to what this guide covers and who it is for.')}${sec('Why it matters')}${sec('How to start')}`;
    else if (optionKey === 'B') body = `${h1(k, 'How do you get found online?')}<div class="pv-card" style="border-color:${k.border};background:${k.surface};margin-bottom:22px"><div style="font:600 12px ${safe(k.font)};letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:6px">Short answer</div><h3 style="${k.h3};font-size:22px;line-height:30px">Make each page answer one clear question, in plain words, with a clear next step.</h3></div>${sec('The detail')}`;
    else body = `${h1(k, 'Getting found online: your questions')}${['How long does it take?', 'Do I need a new website?', 'What does it cost?'].map((q) => `<div style="border-bottom:1px solid ${k.border};padding:14px 0"><h3 style="${k.h3};font-size:21px;margin-bottom:6px">${esc(q)}</h3><p style="${k.body};font-size:15px">A direct answer in two or three sentences.</p></div>`).join('')}`;
  }
  return body ? `<div class="pv">${body}</div>` : null;
}

// { [generatorId]: { [optionKey]: '<html>' } } for one site, or {} when there is nothing to draw.
export async function previewsFor(site, catalog, deps = {}) {
  const { origin, hrefs } = await getSiteStylesheets(site, deps.fetchImpl);
  const kit = designKitFor(site);
  const head = `<!doctype html><meta charset="utf-8">${origin ? `<base href="${esc(origin)}/">` : ''}${hrefs.slice(0, 4).map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join('')}<style>${LAYOUT_CSS}</style>`;
  const out = {};
  for (const [generatorId, def] of Object.entries(catalog)) {
    for (const o of def.options) {
      const html = renderOption(generatorId, o.key, kit, site?.name);
      if (html) (out[generatorId] ||= {})[o.key] = head + html;
    }
  }
  return out;
}
