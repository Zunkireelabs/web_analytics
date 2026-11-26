// In-browser measurers for design protection. Every function here runs INSIDE the page (page.evaluate serialises it), so each is fully self-contained:
// no imports, no closures over module scope. They return plain data; all judgement lives in compare.js / decide.js (pure, tested without a browser).
// The body region is the one body-measure.js's measureBodyInPage already finds and marks (`data-gate-region`): that function is reused, not copied.

/* eslint-disable no-undef */

/** Removes what must never count as "the site's design": platform-written SEOAI marker content and cookie/consent/overlay UI. Our own tab only. */
export function prepareForBaselineInPage() {
  let markerNodes = 0; let overlays = 0;
  // 1. content between <!-- SEOAI:X:START --> and <!-- SEOAI:X:END -->
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
  const starts = []; let n = walker.nextNode();
  while (n) { const t = n.data.trim(); const m = t.match(/^SEOAI:([A-Z0-9_-]+):(START|END)$/i); if (m) starts.push({ node: n, name: m[1].toUpperCase(), kind: m[2].toUpperCase() }); n = walker.nextNode(); }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]; if (s.kind !== 'START') continue;
    const e = starts.slice(i + 1).find((x) => x.kind === 'END' && x.name === s.name); if (!e) continue;
    let cur = s.node.nextSibling;
    while (cur && cur !== e.node) { const next = cur.nextSibling; cur.remove(); markerNodes++; cur = next; }
  }
  // 2. cookie banners, consent dialogs and fixed overlays (a cookie banner recorded as the page "hero" is what mis-captured Zennly, 2026-11-25)
  const sel = '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i],[aria-label*="consent" i],[role="dialog"],[class*="gdpr" i],[id*="gdpr" i],[class*="onetrust" i],[id*="onetrust" i]';
  for (const el of [...document.querySelectorAll(sel)]) { if (el !== document.body && el !== document.documentElement && !el.contains(document.querySelector('main, article'))) { el.remove(); overlays++; } }
  for (const el of [...document.querySelectorAll('body *')]) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' && el.getBoundingClientRect().width >= window.innerWidth * 0.8 && el.getBoundingClientRect().height < window.innerHeight * 0.5 && !/^(header|nav)$/i.test(el.tagName) && !el.querySelector('nav')) { el.remove(); overlays++; }
  }
  return { markerNodes, overlays };
}

/** What the template's body region really uses, beyond what measureBodyInPage reports. Needs `data-gate-region` (run measureBodyInPage(true) first). */
export function measureTemplateExtrasInPage() {
  const region = document.querySelector('[data-gate-region]');
  if (!region) return { found: false };
  const px = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  const fam = (cs) => String(cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  const style = (el) => { if (!el) return null; const cs = getComputedStyle(el); return { family: fam(cs), fontSize: px(cs.fontSize), fontWeight: String(cs.fontWeight), color: cs.color }; };
  const paras = [...region.querySelectorAll('p')].filter((p) => (p.textContent || '').trim().length > 40);
  const modal = (arr) => { const c = new Map(); for (const v of arr) c.set(v, (c.get(v) || 0) + 1); let best = null; let top = 0; for (const [v, k] of c) if (k > top) { best = v; top = k; } return best; };
  const pSizeModal = modal(paras.map((p) => px(getComputedStyle(p).fontSize)));
  const p = paras.find((x) => px(getComputedStyle(x).fontSize) === pSizeModal) || paras[0] || null;
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') return b; } return 'rgb(255, 255, 255)'; };
  const els = [region, ...region.querySelectorAll('*')].slice(0, 601);
  const radii = new Set(); const vocab = new Set();
  for (const el of els) {
    const r = Math.round(px(getComputedStyle(el).borderTopLeftRadius)); if (r > 0) radii.add(r);
    for (const c of (el.getAttribute('class') || '').split(/\s+/)) if (c) vocab.add(c);
  }
  const classOfMost = (selector) => { const list = [...region.querySelectorAll(selector)]; if (!list.length) return undefined; return modal(list.map((e) => (e.getAttribute('class') || '').trim())) ?? ''; };
  const elementClasses = { h2: classOfMost('h2'), h3: classOfMost('h3'), p: classOfMost('p'), ul: classOfMost('ul'), ol: classOfMost('ol'), table: classOfMost('table'), blockquote: classOfMost('blockquote'), a: classOfMost('a'), details: classOfMost('details'), summary: classOfMost('summary') };
  // Patterns the template ALREADY shows: a new block of that kind must copy one of these, never invent its own.
  const pat = (el, extra = {}) => (el ? { present: true, classes: (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 20), ...extra } : { present: false });
  const faqEl = region.querySelector('details > summary')?.closest('details')?.parentElement || [...region.querySelectorAll('[class*="faq" i], [id*="faq" i]')][0]
    || [...region.querySelectorAll('h2, h3')].find((h) => /faq|frequently asked|häufige fragen|veelgestelde/i.test(h.textContent || ''))?.parentElement || null;
  const tableEl = region.querySelector('table');
  const relatedEl = [...document.querySelectorAll('[class*="related" i], nav[aria-label*="related" i], aside ul')][0] || null;
  const crumbEl = [...document.querySelectorAll('[class*="breadcrumb" i], nav[aria-label*="breadcrumb" i], [aria-label*="breadcrumb" i]')][0] || null;
  const patterns = {
    faq: pat(faqEl, (() => { const q = region.querySelector('details > summary'); return q ? { questionStyle: style(q) } : {}; })()), table: pat(tableEl, tableEl ? { cellFontSize: px(getComputedStyle(tableEl.querySelector('td, th') || tableEl).fontSize), border: getComputedStyle(tableEl.querySelector('td, th') || tableEl).borderTopWidth } : {}),
    'related-links': pat(relatedEl), breadcrumbs: pat(crumbEl),
  };
  const headingLevels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]));
  return {
    found: true,
    p: p ? style(p) : null, h1: style(document.querySelector('h1')), h2: style(region.querySelector('h2')), h3: style(region.querySelector('h3')),
    link: style(region.querySelector('a')), background: bgOf(region), containerWidth: Math.round(region.getBoundingClientRect().width),
    radii: [...radii].sort((a, b) => a - b), vocabulary: [...vocab].slice(0, 400), elementClasses, patterns, headingLevels,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
}

/** The block that was injected inside <div data-dp-block style="display:contents">. */
export function measureInsertedBlockInPage() {
  const wrap = document.querySelector('[data-dp-block]');
  if (!wrap) return { found: false };
  const px = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  const fam = (cs) => String(cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  const all = [...wrap.querySelectorAll('*')];
  const sty = (el) => { const cs = getComputedStyle(el); const fs = px(cs.fontSize); const lh = cs.lineHeight === 'normal' ? fs * 1.2 : px(cs.lineHeight); return { family: fam(cs), fontSize: fs, fontWeight: String(cs.fontWeight), color: cs.color, lineHeightRatio: fs ? Math.round((lh / fs) * 100) / 100 : 0 }; };
  const modal = (arr) => { const c = new Map(); for (const v of arr) c.set(JSON.stringify(v), (c.get(JSON.stringify(v)) || 0) + 1); let best = null; let top = 0; for (const [v, k] of c) if (k > top) { best = v; top = k; } return best ? JSON.parse(best) : null; };
  const textEls = [...wrap.querySelectorAll('p, li, dd, td')].filter((e) => (e.textContent || '').trim().length > 1);
  const q = wrap.querySelector('summary');
  const hs = {}; for (const l of [1, 2, 3, 4, 5, 6]) { const h = wrap.querySelector(`h${l}`); if (h) hs[`h${l}`] = sty(h); }
  const links = wrap.querySelector('a');
  const vw = window.innerWidth;
  const inScroller = (el) => { for (let e = el.parentElement; e && e !== wrap.parentElement; e = e.parentElement) { const ox = getComputedStyle(e).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true; } return false; };
  const overflowing = all.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1 && !inScroller(el); }).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(/\s+/)[0]}` : ''}`);
  const classes = new Set(); const radii = new Set();
  for (const el of all) { for (const c of (el.getAttribute('class') || '').split(/\s+/)) if (c) classes.add(c); const r = Math.round(px(getComputedStyle(el).borderTopLeftRadius)); if (r > 0) radii.add(r); }
  const table = wrap.querySelector('table'); const cell = table && table.querySelector('td, th');
  const first = wrap.firstElementChild; const rect = first ? first.getBoundingClientRect() : null;
  const prev = wrap.previousElementSibling; const gapBefore = rect && prev ? Math.round(rect.top - prev.getBoundingClientRect().bottom) : null;
  const widths = [...wrap.children].map((c) => Math.round(c.getBoundingClientRect().width));
  return {
    found: true, text: modal(textEls.map(sty)), question: q ? sty(q) : null, headings: hs, link: links ? sty(links) : null, classes: [...classes], radii: [...radii].sort((a, b) => a - b),
    headingLevels: [...wrap.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1])), h1Count: wrap.querySelectorAll('h1').length,
    maxWidth: widths.length ? Math.max(...widths) : 0, gapBefore, overflowing,
    table: table ? { cellFontSize: px(getComputedStyle(cell || table).fontSize), border: getComputedStyle(cell || table).borderTopWidth, wrapped: inScroller(table) } : null,
    elementCount: all.length,
  };
}

/**
 * A signature of everything OUTSIDE the changed zone, for before/after equality. Zone = the SEOAI marker's content (marker mode), or [data-dp-block]
 * (after), or the body region's descendants (region mode). Position (top) and height are NOT compared: content below a legitimately taller block
 * moves down; what must not change is what each element IS and how it is styled.
 */
export function snapshotOutsideInPage([marker, skipRegion]) {
  const zone = [];
  if (marker) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    let start = null; let end = null; let n = walker.nextNode();
    while (n) { const t = n.data.trim(); if (!start && t === `SEOAI:${marker}:START`) start = n; else if (start && !end && t === `SEOAI:${marker}:END`) { end = n; break; } n = walker.nextNode(); }
    if (start && end) { let cur = start.nextSibling; while (cur && cur !== end) { zone.push(cur); cur = cur.nextSibling; } }
  }
  const region = skipRegion ? document.querySelector('[data-gate-region]') : null;
  const inZone = (el) => el.closest('[data-dp-block]') || zone.some((z) => z === el || (z.nodeType === 1 && z.contains(el))) || (region && region !== el && region.contains(el));
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; };
  const out = [];
  for (const el of [...document.body.querySelectorAll('*')].slice(0, 4000)) {
    if (inZone(el)) continue;
    const cs = getComputedStyle(el);
    const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.data.trim()).join(' ');
    out.push([el.tagName.toLowerCase(), el.id || '', String(el.getAttribute('class') || '').slice(0, 80), cs.fontSize, cs.color, cs.backgroundColor, cs.display, cs.position, Math.round(el.getBoundingClientRect().width), hash(own)].join('|'));
  }
  return { count: out.length, sig: out, heading: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1])), overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
}

/** Wraps `html` in a display:contents block at the marker (replacing its content), at the end of the body region, or as the whole body region. */
export function injectBlockInPage([mode, marker, html]) {
  const wrapper = document.createElement('div'); wrapper.setAttribute('data-dp-block', '1'); wrapper.style.display = 'contents'; wrapper.innerHTML = html;
  if (mode === 'marker') {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    let start = null; let end = null; let n = walker.nextNode();
    while (n) { const t = n.data.trim(); if (!start && t === `SEOAI:${marker}:START`) start = n; else if (start && !end && t === `SEOAI:${marker}:END`) { end = n; break; } n = walker.nextNode(); }
    if (!start || !end) return false;
    let cur = start.nextSibling; while (cur && cur !== end) { const next = cur.nextSibling; cur.remove(); cur = next; }
    end.parentNode.insertBefore(wrapper, end); return true;
  }
  const region = document.querySelector('[data-gate-region]');
  if (!region) return false;
  if (mode === 'region') { region.innerHTML = ''; region.appendChild(wrapper); return true; }
  if (mode === 'append') { region.appendChild(wrapper); return true; }
  return false;
}
/* eslint-enable no-undef */
