// Measure how an article/page BODY actually renders, and compare two
// measurements. The shared core of the two browser checks that make "the
// generated page looks like the site" testable rather than hoped for:
//   - inline-prose-detect.js: is the site's layout already styling prose?
//   - generators/lib/newpage-render-gate.js: does a draft body render like a
//     real page of the same role?
//
// measureBodyInPage runs INSIDE the browser (page.evaluate) so it must be
// fully self-contained — no imports, no closures over module scope.
// Everything else here is pure so the comparison policy is tested without a
// browser.

export const MEASURE_VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'desktop', width: 1440, height: 900 }),
  Object.freeze({ name: 'mobile', width: 390, height: 844 }),
]);

/* eslint-disable no-undef */
export function measureBodyInPage(mark) {
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const pluginRe = /(^|\s)(prose|prose-[\w-]+|typography|article-body|rich-text|richtext|post-content|entry-content|markdown-body)(\s|$)/;

  let region = document.querySelector('[data-gate-region]');
  if (!region) {
    // The body region is the candidate holding the most real paragraph text:
    // `main` alone would include nav/footer chrome, `article` may be absent.
    const candidates = [...document.querySelectorAll('article, [class*="prose"], .post-content, .entry-content, .article-body, main')];
    let best = null; let bestScore = 0;
    for (const c of candidates) {
      const score = [...c.querySelectorAll('p')].reduce((n, p) => n + (p.textContent || '').trim().length, 0);
      if (score > bestScore) { best = c; bestScore = score; }
    }
    region = best;
    if (region && mark) region.setAttribute('data-gate-region', '1');
  }
  if (!region) return { found: false };

  const stat = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const fontSize = px(cs.fontSize);
    const lh = cs.lineHeight === 'normal' ? fontSize * 1.2 : px(cs.lineHeight);
    return {
      fontSize, lineHeightRatio: fontSize ? Math.round((lh / fontSize) * 100) / 100 : 0,
      marginTop: px(cs.marginTop), marginBottom: px(cs.marginBottom),
      borderBottom: px(cs.borderBottomWidth), fontWeight: cs.fontWeight,
    };
  };
  const paras = [...region.querySelectorAll('p')].filter((p) => (p.textContent || '').trim().length > 40);
  const gaps = [];
  for (let i = 1; i < paras.length; i++) {
    const a = paras[i - 1].getBoundingClientRect(); const b = paras[i].getBoundingClientRect();
    const g = b.top - a.bottom;
    if (g >= 0 && g < 200) gaps.push(g);
  }
  gaps.sort((x, y) => x - y);
  const firstP = paras[0] || null;
  const pStat = stat(firstP);
  const regionRect = region.getBoundingClientRect();
  let plugin = false;
  for (let el = region; el && el !== document.documentElement; el = el.parentElement) {
    if (pluginRe.test(el.className && el.className.baseVal === undefined ? String(el.className) : '')) { plugin = true; break; }
  }
  const pWidth = firstP ? firstP.getBoundingClientRect().width : 0;
  return {
    found: true,
    regionWidth: Math.round(regionRect.width),
    h2: stat(region.querySelector('h2')),
    h3: stat(region.querySelector('h3')),
    p: pStat,
    paragraphGap: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
    // ~0.5em is the average glyph width, so this is characters per line.
    lineChars: pStat && pStat.fontSize ? Math.round(pWidth / (pStat.fontSize * 0.5)) : null,
    dividers: region.querySelectorAll('hr').length,
    paragraphs: paras.length,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    pluginClass: plugin,
    bodyFontSize: px(getComputedStyle(document.body).fontSize),
  };
}

export function injectBodyInPage(html) {
  const region = document.querySelector('[data-gate-region]');
  if (!region) return false;
  region.innerHTML = html;
  return true;
}
/* eslint-enable no-undef */

// Tolerances are deliberately loose enough that two honest pages of the same
// site never trip them, and tight enough that the reported bug (30-48px
// headings against 28px) is far outside. A ratio, not an absolute: a site's
// own scale is the only valid yardstick.
export const TOLERANCES = Object.freeze({
  h2FontSize: 0.15, pFontSize: 0.10, lineHeight: 0.12, paragraphGap: 0.35, lineChars: 0.25,
});

const off = (a, b, tol) => (a > 0 && b > 0 ? Math.abs(b - a) / a > tol : false);

// Compare the REFERENCE page's own measurement (what the site really does)
// with the DRAFT's, measured in the same region. Never against absolutes.
export function compareBodyMeasures(ref, draft, viewport = { name: 'desktop' }, tol = TOLERANCES) {
  const out = [];
  if (!ref?.found || !draft?.found) return out;
  const add = (kind, expected, actual) => out.push({ kind, expected, actual, viewport: viewport.name });

  if (ref.h2 && draft.h2 && off(ref.h2.fontSize, draft.h2.fontSize, tol.h2FontSize)) add('heading-scale', ref.h2.fontSize, draft.h2.fontSize);
  if (ref.p && draft.p && off(ref.p.fontSize, draft.p.fontSize, tol.pFontSize)) add('body-size', ref.p.fontSize, draft.p.fontSize);
  if (ref.p && draft.p && off(ref.p.lineHeightRatio, draft.p.lineHeightRatio, tol.lineHeight)) add('line-height', ref.p.lineHeightRatio, draft.p.lineHeightRatio);
  // +4px absolute slack: two paragraph gaps of 14 and 17px are not a defect.
  if (ref.paragraphGap != null && draft.paragraphGap != null
    && Math.abs(draft.paragraphGap - ref.paragraphGap) > 4 && off(ref.paragraphGap, draft.paragraphGap, tol.paragraphGap)) {
    add('paragraph-gap', ref.paragraphGap, draft.paragraphGap);
  }
  if (ref.lineChars && draft.lineChars && off(ref.lineChars, draft.lineChars, tol.lineChars)) add('line-length', ref.lineChars, draft.lineChars);
  // A rule under headings is a site convention: present on the reference and
  // gone from the draft (or the reverse) breaks the flow.
  if (ref.h2 && draft.h2 && (ref.h2.borderBottom > 0) !== (draft.h2.borderBottom > 0)) add('heading-rule', ref.h2.borderBottom, draft.h2.borderBottom);
  if (draft.horizontalOverflow && !ref.horizontalOverflow) add('horizontal-overflow', false, true);
  return out;
}

// --- Tailwind font-size resolution (for projecting a profile class to px) ---
const TW_SIZES = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 };
const TW_BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };

// The font-size a utility class string resolves to at a viewport width, or
// null when it names none. Responsive prefixes apply cumulatively (md: from
// 768px up), the widest applicable one winning — which is why a class like
// `text-3xl md:text-4xl lg:text-5xl` is 48px on desktop, not 30.
export function tailwindFontSizePx(classString, viewportWidth = 1440) {
  let size = null; let bestBp = -1;
  for (const token of String(classString || '').split(/\s+/).filter(Boolean)) {
    const parts = token.split(':');
    const util = parts.pop();
    const variants = parts;
    if (variants.some((v) => !(v in TW_BREAKPOINTS))) continue; // hover:, dark: etc. do not apply to a plain render
    const bp = variants.length ? TW_BREAKPOINTS[variants[variants.length - 1]] : 0;
    if (bp > viewportWidth || bp < bestBp) continue;
    const m = util.match(/^text-(xs|sm|base|lg|xl|[2-9]xl)$/);
    const arb = util.match(/^text-\[(\d+(?:\.\d+)?)px\]$/);
    const v = m ? TW_SIZES[m[1]] : arb ? Number(arb[1]) : null;
    if (v != null) { size = v; bestBp = bp; }
  }
  return size;
}
