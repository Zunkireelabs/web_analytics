import { launchBrowser, DESKTOP_VIEWPORT } from '../../design-agent/live-analysis/capture.js';

// STYLE FIDELITY: does a content block the agent is about to publish LOOK like part of the page it lands on?
//
// WHY THIS EXISTS. Every other check on a draft looks at markup or at layout mechanics. The responsive gate (responsive-preview-gate.js) renders the block in the
// real page but only asks whether it overflows, clips or has tiny tap targets. A bare `<dl><dt>Q</dt><dd>A</dd></dl>` does none of those, so unstyled FAQs reached
// MOBILISE and Superrank (2026-11-23): plain text, questions indistinguishable from answers, no spacing. This asks the question people actually asked: put the block in
// the real page, in a real browser, and measure whether it belongs there.
//
// HOW IT JUDGES. Never from class names or markup: from the browser's computed styles, compared with the page the block lands in. The page is its own reference, so
// nothing here is a per-site setting and it works for every client.
//   font-mismatch          the block's text is set in a different font family from the page's own paragraphs.
//   off-scale-size         a font size the page's own text never uses (a type scale is a design decision; a stray 13.5px is not part of it).
//   off-palette-colour     a text colour the page's own text never uses (a hard-coded colour instead of the site's).
//   off-palette-background a background colour no element of the page has.
//   no-hierarchy           (question/answer blocks) the questions look exactly like the answers: the signature of unstyled <dt>/<dd> and bare <details>.
//   crammed                the block's items run together with no air, where the page's own paragraphs have air between them.
//   butted                 (not for a full-width page band) the block touches the content above it, where the page's own paragraphs are separated (judged only where the page's own marker fixes the
//                          position: a guessed position says nothing about where the block will really sit).
//   out-of-container       the block sticks out of the page's own text column (the column the page's paragraphs sit in).
//   alignment-mismatch     the block's text is aligned differently from the page's own paragraphs (centered answers in a left-aligned article).
//   mobile-overflow        at a phone width the block is wider than the screen.
//   mobile-tiny-text       at a phone width the block's text is below a readable size.
//
// WHERE THE BLOCK GOES. Into the page's own SEOAI marker when the live page has it. A first insertion has no marker yet, and the responsive gate skips that case
// entirely; here the block goes at the end of the page's main text container instead, which is where the platform places these blocks, so a first insertion is judged too.
//
// WHAT IT IS NOT. It does not judge taste. It cannot tell a pleasing design from a plain one that follows the page's own rules, and a block that follows the page's
// font, type scale, colours, spacing and column will pass. It catches a block that does not.
//
// STYLE_FIDELITY_GATE (env): enforce (default) refuses the draft; log records and lets it through; off skips the check. A check that could not run (the page is
// unreachable, no browser slot is free) is NOT a pass: in enforce mode the draft is held and retried, the same as the responsive gate. A page with nowhere to put the
// block is skipped: there is nothing to judge.
export const styleFidelityMode = (env = process.env) => (['enforce', 'log', 'off'].includes(String(env.STYLE_FIDELITY_GATE || 'enforce').toLowerCase()) ? String(env.STYLE_FIDELITY_GATE || 'enforce').toLowerCase() : 'enforce');

// The markers whose blocks are judged, and whether they carry question/answer pairs.
export const STYLE_CHECKED_MARKERS = Object.freeze({ FAQ: 'qa', QACONTENT: 'qa', EXPANDEDCONTENT: 'prose', INTERNALLINKS: 'prose', DIRECTANSWER: 'prose' });

const NAV_TIMEOUT_MS = Number(process.env.STYLE_FIDELITY_NAV_TIMEOUT_MS) || 20_000;
export const MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844 });

// Tolerances. Each is the smallest value that does not flag a design the platform's own live clients already ship (checked against their live pages).
const COLOUR_TOLERANCE = 28;   // RGB distance: opacity and hover variants of the same colour are the same colour
const SIZE_TOLERANCE_PX = 2;   // one page shows only some of the site's sizes; 18px beside 20px is the same scale, 11px beside 18px is not
const CONTAINER_SLACK_PX = 2;  // mobile overflow
const COLUMN_SLACK_PX = 24;    // a card or indent may sit a little inside or outside the text column; a different width is a different design
const MIN_MOBILE_TEXT_PX = 11;
const CRAMMED_GAP_PX = 6;
const RHYTHM_MIN_PX = 10;      // only call a block crammed/butted where the page's own paragraphs have at least this much air

// Runs IN the page (serialised by page.evaluate): puts `html` where the marker is (or at the end of the main text container), tags what it inserted, then reads the
// typography, colours and spacing of the insertion and of the page around it.
/* eslint-disable no-undef */
export function measureBlockStyle([marker, html]) {
  const out = { injected: false, fullBleed: false, refFamily: null, blockFamily: null, headingFamilies: [], refFamilies: [], pageFamilies: [], refAlign: null, blockAlign: null, pairs: [], textElements: 0, pageSizes: [], pageColours: [], pageBackgrounds: [], blockSizes: [], blockColours: [], blockBackgrounds: [], rhythm: null, gapAbove: null, outside: null };

  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const nodes = [...wrapper.childNodes];

  // 1. the marker the live page already has
  const startLabel = `SEOAI:${marker}:START`;
  const endLabel = `SEOAI:${marker}:END`;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
  let startNode = null; let endNode = null; let c = walker.nextNode();
  while (c) {
    const t = c.data.trim();
    if (!startNode && t === startLabel) startNode = c; else if (startNode && !endNode && t === endLabel) { endNode = c; break; }
    c = walker.nextNode();
  }
  let container = null;
  if (startNode && endNode) {
    let cur = startNode.nextSibling;
    while (cur && cur !== endNode) { const next = cur.nextSibling; cur.remove(); cur = next; }
    for (const n of nodes) startNode.parentNode.insertBefore(n, endNode);
    container = startNode.parentElement;
    out.injected = 'marker';
  } else {
    // 2. a first insertion: the end of the page's main text column. That is the element whose own paragraphs hold the most text, found among every element
    // rather than a list of class names, so a page built from <section>/<div> blocks (not <article>/<main>) is judged too.
    let best = null; let bestLen = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (['SCRIPT', 'STYLE', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM'].includes(el.tagName) || el.closest('nav, header, footer, aside')) continue;
      let len = 0; let paras = 0;
      for (const ch of el.children) if (ch.tagName === 'P' || ch.tagName === 'UL' || ch.tagName === 'OL') { len += (ch.textContent || '').trim().length; if (ch.tagName === 'P') paras += 1; }
      if (paras >= 2 && len > bestLen) { best = el; bestLen = len; }
    }
    if (!best || bestLen < 200) return out;
    for (const n of nodes) best.appendChild(n);
    container = best;
    out.injected = 'fallback';
  }

  const els = [];
  for (const n of nodes) { if (n.nodeType === 1) { n.setAttribute('data-sf-block', '1'); els.push(n); els.push(...n.querySelectorAll('*')); } }
  const inBlock = (el) => el.closest('[data-sf-block]') !== null;
  const family = (el) => getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  const mode = (arr) => { const m = new Map(); for (const v of arr) m.set(v, (m.get(v) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null; };
  const hasOwnText = (el) => [...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim().length > 1);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const style = (el) => { const cs = getComputedStyle(el); return { weight: Number(cs.fontWeight) || 400, size: parseFloat(cs.fontSize) || 0, color: cs.color, italic: cs.fontStyle, upper: cs.textTransform }; };
  const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const key = (c) => `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`;

  // the page's own typography: text elements outside the block (one pass, capped so a huge page stays fast)
  const pageSizes = new Set(); const pageColours = new Set(); const pageBgs = new Set();
  const refParas = [];
  let seen = 0;
  for (const el of document.body.querySelectorAll('p, a, li, h1, h2, h3, h4, h5, h6, span, dt, dd, small, label, button, summary, blockquote, td, th, div')) {
    if (seen > 2500) break;
    if (inBlock(el) || !hasOwnText(el) || !visible(el)) continue;
    seen += 1;
    const cs = getComputedStyle(el);
    pageSizes.add(Math.round(parseFloat(cs.fontSize)));
    const col = rgb(cs.color); if (col) pageColours.add(key(col));
    if (el.tagName === 'P' && (el.textContent || '').trim().length > 40) refParas.push(el);
  }
  let bgSeen = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (bgSeen > 3000) break; bgSeen += 1;
    if (inBlock(el)) continue;
    const b = rgb(getComputedStyle(el).backgroundColor); if (b && b.a > 0.05) pageBgs.add(key(b));
  }
  const html0 = rgb(getComputedStyle(document.documentElement).backgroundColor); if (html0 && html0.a > 0.05) pageBgs.add(key(html0));
  const body0 = rgb(getComputedStyle(document.body).backgroundColor); if (body0 && body0.a > 0.05) pageBgs.add(key(body0));
  pageBgs.add('255,255,255'); // an unpainted page is white
  out.pageSizes = [...pageSizes]; out.pageColours = [...pageColours]; out.pageBackgrounds = [...pageBgs];
  const refFams = refParas.filter((p) => p.getBoundingClientRect().height > 0).map(family);
  out.refFamily = mode(refFams);
  // a page can set its body text in more than one family (Admizz: 22 paragraphs in Rubik, 13 in Montserrat); every family a fair share of its paragraphs use is the page's
  const famCount = new Map(); for (const f of refFams) famCount.set(f, (famCount.get(f) || 0) + 1);
  out.refFamilies = [...famCount.entries()].filter(([, n]) => n / Math.max(1, refFams.length) >= 0.2).map(([f]) => f);

  const textEls = els.filter((e) => hasOwnText(e) && visible(e));
  out.textElements = textEls.length;
  // Body text is compared with the page's body text; headings are only asked to use a family the page uses somewhere (a display font for headings is a design).
  const isHeading = (e) => /^(H[1-6]|DT|SUMMARY)$/.test(e.tagName);
  const bodyEls = textEls.filter((e) => !isHeading(e));
  out.blockFamily = mode((bodyEls.length ? bodyEls : textEls).map(family));
  out.headingFamilies = [...new Set(textEls.filter(isHeading).map(family))];
  const famSet = new Set();
  let famSeen = 0;
  for (const el of document.body.querySelectorAll('p, a, li, h1, h2, h3, h4, h5, h6, span, dt, dd, button, label, summary')) {
    if (famSeen > 1500) break;
    if (inBlock(el) || !hasOwnText(el) || !visible(el)) continue;
    famSeen += 1; famSet.add(family(el));
  }
  out.pageFamilies = [...famSet];
  const alignOf = (e) => { const a = getComputedStyle(e).textAlign; return a === 'start' ? 'left' : a === 'end' ? 'right' : a; };
  out.refAlign = mode(refParas.filter((p) => p.getBoundingClientRect().height > 0).map(alignOf));
  // paragraph-like text only: a link or button label is centred by design and says nothing about how the block's prose is set
  out.blockAlign = mode(bodyEls.filter((e) => ['P', 'DD', 'BLOCKQUOTE', 'LI'].includes(e.tagName) && (e.textContent || '').trim().length > 40 && [...e.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim().length > 40)).map(alignOf));
  out.blockSizes = [...new Set(textEls.map((e) => Math.round(parseFloat(getComputedStyle(e).fontSize))))];
  out.blockColours = [...new Set(textEls.map((e) => rgb(getComputedStyle(e).color)).filter(Boolean).map(key))];
  const bgs = new Set();
  for (const e of els) { const b = rgb(getComputedStyle(e).backgroundColor); if (b && b.a > 0.05 && visible(e)) bgs.add(key(b)); }
  out.blockBackgrounds = [...bgs];

  // the page's own vertical rhythm: the gap between two paragraphs that sit directly one after the other (a heading between them would measure the heading's
  // spacing, not the paragraphs'). Needs a few such pairs to be a rhythm at all.
  const gaps = [];
  for (const p of refParas) {
    const next = p.nextElementSibling;
    if (next && next.tagName === 'P' && !inBlock(next) && visible(next) && gaps.length < 40) {
      const g = next.getBoundingClientRect().top - p.getBoundingClientRect().bottom;
      if (g >= 0 && g < 120) gaps.push(g);
    }
  }
  gaps.sort((x, y) => x - y);
  out.rhythm = gaps.length >= 3 ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null;

  // a page BAND (a <section>, or anything spanning the viewport) is spaced by its own padding and is as wide as the page by design: it is not "in" the text column
  const firstRendered = nodes.find((n) => n.nodeType === 1 && n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0);
  out.fullBleed = Boolean(firstRendered) && (firstRendered.tagName === 'SECTION' || (firstRendered.getBoundingClientRect().width >= window.innerWidth * 0.9 && firstRendered.getBoundingClientRect().width <= window.innerWidth + 2));

  // the block against what is above it, and against the column it sits in
  const first = nodes.find((n) => n.nodeType === 1);
  if (first) {
    const r = first.getBoundingClientRect();
    let prev = first.previousElementSibling;
    while (prev && !visible(prev)) prev = prev.previousElementSibling;
    if (prev) out.gapAbove = Math.round(r.top - prev.getBoundingClientRect().bottom);
    // the column the page's own text sits in: the paragraphs that share the most common left edge (within a few px). A page built from sections of different
    // widths has no single text column to hold a block to, so it is not judged on column at all.
    const lefts = new Map();
    for (const rp of refParas) { const l = Math.round(rp.getBoundingClientRect().left / 4) * 4; lefts.set(l, (lefts.get(l) || 0) + 1); }
    const [domKey, domCount] = [...lefts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const colLeftKey = domCount >= 3 && domCount / Math.max(1, refParas.length) >= 0.5 ? domKey : null;
    if (colLeftKey != null) {
      const colParas = refParas.filter((rp) => Math.round(rp.getBoundingClientRect().left / 4) * 4 === colLeftKey);
      const colLeft = Math.min(...colParas.map((rp) => rp.getBoundingClientRect().left)); const colRight = Math.max(...colParas.map((rp) => rp.getBoundingClientRect().right));
      // rendered elements only: a <script> (the FAQ's structured data) or any display:none node has a zero-size box at the page's origin
      // where the block's CONTENT sits (its text and images), not its layout boxes: a wrapper with margins or padding that reuses the page's own column classes
      // is wider than the text inside it and still lines up with the page's text exactly
      let rects = els.filter((e) => (hasOwnText(e) || ['IMG', 'SVG', 'VIDEO', 'TABLE'].includes(e.tagName))).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) rects = nodes.filter((n) => n.nodeType === 1).map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      if (rects.length) {
        const blockLeft = Math.min(...rects.map((r) => r.left));
        const blockRight = Math.max(...rects.map((r) => r.right));
        out.outside = { left: Math.round(colLeft - blockLeft), right: Math.round(blockRight - colRight) };
      }
    }
  }

  // question / answer pairs, in document order
  const isQ = (e) => /^(DT|SUMMARY|H[1-6])$/.test(e.tagName) && (e.textContent || '').trim();
  const isA = (e) => /^(DD|P)$/.test(e.tagName) && !e.closest('summary') && (e.textContent || '').trim();
  const questions = els.filter(isQ);
  const answers = els.filter(isA);
  const textRect = (el, end) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return end ? b.bottom : b.top; };
  questions.forEach((q, i) => {
    const next = questions[i + 1] || null;
    const a = answers.find((x) => (q.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) && (!next || (next.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_PRECEDING)));
    if (!a) return;
    // an answer inside a closed <details> has no real position (its box is collapsed, and a range over it measures nonsense)
    const rendered = a.getBoundingClientRect().height > 0 && !a.closest('details:not([open])');
    let gap = null;
    if (rendered && next) { const g = Math.round(textRect(next, false) - textRect(a, true)); gap = g >= -2 ? g : null; }
    out.pairs.push({ q: style(q), a: style(a), gap });
  });
  return out;
}

// What the block does at a phone width. Runs after measureBlockStyle, on the same page, once the viewport has been narrowed.
// An element inside a horizontally scrolling or clipping wrapper (a wide table in an overflow-x:auto box) is the correct responsive design, not an overflow:
// only the part of an element an ancestor lets through counts.
export function measureBlockMobile() {
  const blocks = [...document.querySelectorAll('[data-sf-block]')];
  const out = { blocks: blocks.length, overflowPx: 0, minText: null, pageAlreadyWide: 0 };
  // A page that already overflows a phone screen without the block (its own layout) is not this block's fault: measure the page with the block hidden and
  // blame the block only for what it adds beyond that.
  const prev = blocks.map((b) => b.style.display);
  blocks.forEach((b) => { b.style.display = 'none'; });
  const baseline = Math.max(document.documentElement.clientWidth, document.documentElement.scrollWidth);
  blocks.forEach((b, i) => { b.style.display = prev[i]; });
  out.pageAlreadyWide = Math.max(0, baseline - document.documentElement.clientWidth);
  const vw = baseline;
  const visibleRight = (el, right) => {
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(a).overflowX)) right = Math.min(right, a.getBoundingClientRect().right);
    }
    return right;
  };
  for (const b of blocks) {
    for (const el of [b, ...b.querySelectorAll('*')]) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) out.overflowPx = Math.max(out.overflowPx, Math.round(visibleRight(el, r.right) - vw));
      if ([...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim().length > 1) && r.height > 0) {
        const s = parseFloat(getComputedStyle(el).fontSize);
        out.minText = out.minText == null ? s : Math.min(out.minText, s);
      }
    }
  }
  return out;
}
/* eslint-enable no-undef */

const sameStyle = (a, b) => a.weight === b.weight && Math.abs(a.size - b.size) < 0.5 && a.color === b.color && a.italic === b.italic && a.upper === b.upper;
const parseKey = (k) => { const [r, g, b] = String(k).split(',').map(Number); return { r, g, b }; };
const colourDistance = (a, b) => Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
const inPalette = (key, palette) => palette.some((p) => colourDistance(parseKey(key), parseKey(p)) <= COLOUR_TOLERANCE);
const hex = (k) => { const { r, g, b } = parseKey(k); return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`; };

/**
 * Pure: turn what the browser measured into a verdict. `kind` is 'qa' (question/answer pairs) or 'prose'. `mobile` is measureBlockMobile's result, or null.
 * @returns {{ status: 'passed'|'failed'|'skipped', issues: Array<{type, detail}>, warnings: Array<{type, detail}>, reason?: string }}
 */
export function judgeStyleFidelity(facts, { kind = 'qa', mobile = null } = {}) {
  if (!facts || !facts.injected) return { status: 'skipped', reason: 'no-insertion-point', issues: [], warnings: [] };
  const issues = []; const warnings = [];

  const allowedBody = facts.refFamilies?.length ? facts.refFamilies : (facts.refFamily ? [facts.refFamily] : []);
  if (allowedBody.length && facts.blockFamily && !allowedBody.includes(facts.blockFamily)) {
    issues.push({ type: 'font-mismatch', detail: `The block's text is set in "${facts.blockFamily}" but this page's own text is set in "${facts.refFamily}".` });
  }
  if (facts.pageFamilies?.length) {
    const stray = (facts.headingFamilies || []).filter((f) => !facts.pageFamilies.includes(f));
    if (stray.length) issues.push({ type: 'font-mismatch', detail: `The block's headings are set in "${stray[0]}", a font nothing else on this page uses.` });
  }
  if (facts.refAlign && facts.blockAlign && facts.refAlign !== facts.blockAlign) {
    issues.push({ type: 'alignment-mismatch', detail: `The block's text is ${facts.blockAlign}-aligned but this page's own paragraphs are ${facts.refAlign}-aligned.` });
  }

  // type scale: a size the page's own text never uses
  if (facts.pageSizes?.length >= 3) {
    const off = (facts.blockSizes || []).filter((s) => !facts.pageSizes.some((p) => Math.abs(p - s) <= SIZE_TOLERANCE_PX));
    if (off.length) issues.push({ type: 'off-scale-size', detail: `The block uses font size ${off.map((s) => `${s}px`).join(', ')}, which no text on this page uses.` });
  }

  // palette: colours the page never uses
  if (facts.pageColours?.length >= 2) {
    const off = (facts.blockColours || []).filter((c) => !inPalette(c, facts.pageColours));
    if (off.length) issues.push({ type: 'off-palette-colour', detail: `The block's text uses ${off.slice(0, 3).map(hex).join(', ')}, which no text on this page uses.` });
  }
  if (facts.pageBackgrounds?.length >= 1) {
    const off = (facts.blockBackgrounds || []).filter((c) => !inPalette(c, facts.pageBackgrounds));
    if (off.length) issues.push({ type: 'off-palette-background', detail: `The block has a ${off.slice(0, 3).map(hex).join(', ')} background, which no part of this page has.` });
  }

  // hierarchy and spacing inside the block
  if (kind === 'qa' && facts.pairs.length >= 2) {
    if (facts.pairs.every((p) => sameStyle(p.q, p.a))) {
      issues.push({ type: 'no-hierarchy', detail: `All ${facts.pairs.length} questions look exactly like their answers (same weight, size and colour), so the block would show as plain unstyled text.` });
    }
    const gaps = facts.pairs.map((p) => p.gap).filter((g) => g != null);
    if (gaps.length >= 2 && gaps.every((g) => g < CRAMMED_GAP_PX)) {
      const rhythmOk = facts.rhythm != null && facts.rhythm >= RHYTHM_MIN_PX;
      (rhythmOk ? issues : warnings).push({ type: 'crammed', detail: `Each answer runs straight into the next question (${Math.max(...gaps)}px apart)${rhythmOk ? `, where this page's own paragraphs are ${facts.rhythm}px apart` : ''}.` });
    }
  }

  // the block against what is above it, and against its column
  if (!facts.fullBleed && facts.injected === 'marker' && facts.gapAbove != null && facts.gapAbove < 2 && facts.rhythm != null && facts.rhythm >= RHYTHM_MIN_PX) {
    issues.push({ type: 'butted', detail: `The block touches the content above it, where this page's own paragraphs are ${facts.rhythm}px apart.` });
  }
  if (!facts.fullBleed && facts.outside && (facts.outside.right > COLUMN_SLACK_PX || facts.outside.left > COLUMN_SLACK_PX)) {
    issues.push({ type: 'out-of-container', detail: `The block sticks out of this page's text column by ${Math.max(facts.outside.left, facts.outside.right)}px.` });
  }

  // at a phone width
  if (mobile?.blocks) {
    if (mobile.overflowPx > CONTAINER_SLACK_PX) issues.push({ type: 'mobile-overflow', detail: `At a phone width the block is ${mobile.overflowPx}px wider than the screen.` });
    if (mobile.minText != null && mobile.minText < MIN_MOBILE_TEXT_PX) issues.push({ type: 'mobile-tiny-text', detail: `At a phone width the block's text is ${mobile.minText}px, below a readable size.` });
  }
  return { status: issues.length ? 'failed' : 'passed', issues, warnings };
}

/**
 * Render `newContentHtml` into the live page and judge it.
 * @returns {Promise<{ ok: boolean, skip?: boolean, passed?: boolean, issues?, warnings?, injected?: string, reason?: string, error?: string }>}
 *   ok false = the check could not run (page unreachable, no browser): the caller HOLDS the draft, it is never a pass.
 */
export async function checkStyleFidelity({ pageUrl, marker, newContentHtml, launchBrowserFn = launchBrowser } = {}) {
  const kind = STYLE_CHECKED_MARKERS[marker];
  if (!kind) return { ok: true, skip: true, reason: 'marker-not-judged' };
  if (!pageUrl || newContentHtml == null || !String(newContentHtml).trim()) return { ok: false, reason: 'missing-input', error: 'pageUrl and newContentHtml are required.' };

  let browser;
  try { browser = await launchBrowserFn(); } catch (err) { return { ok: false, reason: 'browser-unavailable', error: err.message }; }
  try {
    const context = await browser.newContext({ viewport: { width: DESKTOP_VIEWPORT.width, height: DESKTOP_VIEWPORT.height } });
    const page = await context.newPage();
    try { await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); } catch (err) { return { ok: false, reason: 'unreachable', error: err.message }; }
    // fonts and the site's stylesheet decide the computed styles; give them a moment, never forever
    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    const facts = await page.evaluate(measureBlockStyle, [marker, String(newContentHtml)]);
    let mobile = null;
    if (facts.injected) {
      await page.setViewportSize({ width: MOBILE_VIEWPORT.width, height: MOBILE_VIEWPORT.height });
      mobile = await page.evaluate(measureBlockMobile);
    }
    const verdict = judgeStyleFidelity(facts, { kind, mobile });
    if (verdict.status === 'skipped') return { ok: true, skip: true, reason: verdict.reason };
    return { ok: true, passed: verdict.status === 'passed', issues: verdict.issues, warnings: verdict.warnings, injected: facts.injected };
  } catch (err) {
    return { ok: false, reason: 'unreachable', error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

// One honest sentence for a failed verdict, for the draft's error and the person reading it.
export function describeStyleIssues(issues) {
  return (issues || []).map((i) => i.detail).join(' ');
}
