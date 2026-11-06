// RENDERED VISUAL DESIGN CHECK (Phase 2 C) — desktop, tablet and mobile.
//
// Structural fingerprints and class containment say whether two pages are BUILT from the same template.
// They cannot see a template whose CSS changed (same classes, new padding), a section that collapses to
// one column on mobile, or a heading font that silently fell back. This renders both pages in a real
// browser at three widths and compares MEASURED design values per section.
//
// Not pixel comparison. Ignored on purpose, because they vary legitimately between two pages of one
// design: text, images (src, size, loading state), heights that depend on content, and how many times a
// repeated section appears. Fonts are awaited (document.fonts.ready) and animations disabled before
// measuring, so a late font or a running transition is not mistaken for a design change.
//
// Compared, with tolerances: section order (as a sequence of section kinds), column layout, content width,
// vertical padding, background colours, and heading / body typography (family, size, weight, colour).
export const VIEWPORTS = Object.freeze([
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
]);

const TOL = {
  fontSizeRatio: 0.12,   // 12 %: sub-pixel / clamp() noise is allowed, a scale change is not
  paddingPx: 12,         // and 30 %, whichever is larger
  paddingRatio: 0.3,
  widthRatio: 0.15,      // content width
  color: 48,             // RGB distance
  structure: 0.6,        // ordered similarity of section kinds
};

/* eslint-disable no-undef */
// Runs in the page. Measures the top-level content sections (site chrome excluded).
export function measureDesignInPage() {
  const rgb = (c) => { const m = String(c || '').match(/\d+(\.\d+)?/g); return m ? m.slice(0, 3).map(Number) : null; };
  const bgOf = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return rgb(c); e = e.parentElement; } return [255, 255, 255]; };
  const font = (el) => { if (!el) return null; const s = getComputedStyle(el); return { family: s.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase(), size: parseFloat(s.fontSize), weight: Number(s.fontWeight) || 400, color: rgb(s.color) }; };
  const root = document.querySelector('main') || document.body;
  let blocks = [...root.children];
  if (blocks.length === 1 && blocks[0].children.length > 2) blocks = [...blocks[0].children]; // a single wrapper div
  blocks = blocks.filter((el) => {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'nav', 'footer'].includes(tag)) return false;
    if (tag === 'header' && el.parentElement === document.body) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 8;
  });
  const sections = blocks.slice(0, 40).map((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // the widest descendant that is narrower than the section = its content column
    let inner = el; for (const c of el.querySelectorAll(':scope > *, :scope > * > *')) { const w = c.getBoundingClientRect().width; if (w > 0 && w < inner.getBoundingClientRect().width * 0.98 && w > r.width * 0.3) { inner = c; break; } }
    const kids = [...(inner.children.length > 1 ? inner.children : el.children)].filter((k) => k.getBoundingClientRect().width > 0);
    const lefts = new Set(kids.map((k) => Math.round(k.getBoundingClientRect().left / 8)));
    const h = el.querySelector('h1, h2, h3');
    const p = el.querySelector('p');
    const bg = bgOf(el);
    const lum = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255;
    const sat = Math.max(...bg) - Math.min(...bg);
    // A band whose background is a photo or gradient reports no background colour; its TEXT colour still
    // says what it is (light text = dark band). Dark bands align with dark bands.
    const textC = rgb(getComputedStyle(el.querySelector('h1, h2, h3, p') || el).color) || [0, 0, 0];
    const textLum = (0.2126 * textC[0] + 0.7152 * textC[1] + 0.0722 * textC[2]) / 255;
    const tone = lum < 0.35 || textLum > 0.75 ? 'dark' : sat > 60 ? 'accent' : 'light';
    return {
      kind: `${h ? h.tagName.toLowerCase() : 'x'}:${Math.min(lefts.size, 4)}:${tone}`,
      columns: Math.min(lefts.size, 4),
      contentWidth: Math.round(inner.getBoundingClientRect().width),
      padTop: parseFloat(s.paddingTop) || 0,
      padBottom: parseFloat(s.paddingBottom) || 0,
      bg,
      heading: font(h),
      body: font(p),
    };
  });
  return { viewport: window.innerWidth, sections, bodyFont: font(document.body) };
}
/* eslint-enable no-undef */

const DISABLE_MOTION = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';

// Renders one URL at every viewport and returns measured tokens per viewport.
export async function renderDesignTokens(url, { launch = null, viewports = VIEWPORTS, timeoutMs = 25_000, injectCss = null } = {}) {
  const browser = launch ? await launch() : await (await import('../live-analysis/capture.js')).launchBrowser();
  try {
    const out = {};
    for (const vp of viewports) {
      // eslint-disable-next-line no-await-in-loop
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce', isMobile: vp.width < 768, hasTouch: vp.width < 768 });
      try {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.addStyleTag({ content: DISABLE_MOTION }).catch(() => {});
        if (injectCss) await page.addStyleTag({ content: injectCss }); // tests: simulate a stylesheet change
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {}); // late assets: best effort
        await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {}); // eslint-disable-line no-undef
        out[vp.name] = await page.evaluate(measureDesignInPage);
      } finally {
        await ctx.close().catch(() => {});
      }
    }
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── comparison ─────────────────────────────────────────────────────────────

const dist = (a, b) => (a && b ? Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) : 0);

function lcsPairs(a, b, eq) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = eq(a[i - 1], b[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const pairs = []; let i = a.length; let j = b.length;
  while (i > 0 && j > 0) { if (eq(a[i - 1], b[j - 1])) { pairs.unshift([a[i - 1], b[j - 1]]); i--; j--; } else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--; }
  return pairs;
}

function compareFont(vp, where, a, b, issues) {
  if (!a || !b) return;
  if (a.family !== b.family) issues.push({ viewport: vp, kind: 'typography', detail: `${where} font ${a.family} vs ${b.family}` });
  if (Math.abs(a.size - b.size) / Math.max(b.size, 1) > TOL.fontSizeRatio) issues.push({ viewport: vp, kind: 'typography', detail: `${where} size ${a.size}px vs ${b.size}px` });
  if (Math.abs(a.weight - b.weight) >= 200) issues.push({ viewport: vp, kind: 'typography', detail: `${where} weight ${a.weight} vs ${b.weight}` });
  if (dist(a.color, b.color) > TOL.color) issues.push({ viewport: vp, kind: 'color', detail: `${where} colour rgb(${a.color}) vs rgb(${b.color})` });
}

/**
 * Compares a page's rendered design with its reference (group sample, or the page before an edit).
 * @returns {{ verdict: 'match'|'regression'|'unmeasurable', issues: Array, viewports: string[] }}
 */
export function compareDesignTokens(page, reference) {
  const issues = [];
  const viewports = Object.keys(reference || {}).filter((vp) => page?.[vp]);
  if (!viewports.length) return { verdict: 'unmeasurable', issues: [{ kind: 'unmeasurable', detail: 'no viewport was measured on both pages' }], viewports };
  for (const vp of viewports) {
    const A = page[vp].sections || []; const B = reference[vp].sections || [];
    if (!A.length || !B.length) { issues.push({ viewport: vp, kind: 'unmeasurable', detail: 'no content sections were measured' }); continue; }
    compareFont(vp, 'body', page[vp].bodyFont, reference[vp].bodyFont, issues);
    // Align sections by KIND (heading level + column count), so a post with an extra repeated section is
    // not "different", but a different arrangement of kinds is.
    const pairs = lcsPairs(A, B, (x, y) => x.kind === y.kind);
    const structure = pairs.length / Math.max(A.length, B.length);
    if (structure < TOL.structure) issues.push({ viewport: vp, kind: 'layout', detail: `section arrangement differs (${Math.round(structure * 100)}% aligned)` });
    for (const [a, b] of pairs) {
      if (Math.abs(a.contentWidth - b.contentWidth) / Math.max(b.contentWidth, 1) > TOL.widthRatio) issues.push({ viewport: vp, kind: 'layout', detail: `content width ${a.contentWidth}px vs ${b.contentWidth}px (${b.kind})` });
      for (const side of ['padTop', 'padBottom']) {
        const d = Math.abs(a[side] - b[side]);
        if (d > Math.max(TOL.paddingPx, b[side] * TOL.paddingRatio)) issues.push({ viewport: vp, kind: 'spacing', detail: `${side === 'padTop' ? 'top' : 'bottom'} padding ${a[side]}px vs ${b[side]}px (${b.kind})` });
      }
      compareFont(vp, `${b.kind} heading`, a.heading, b.heading, issues);
      compareFont(vp, `${b.kind} body`, a.body, b.body, issues);
    }
    // background colours the page introduces that the reference never uses
    const refBgs = B.map((s) => s.bg);
    for (const s of A) if (refBgs.every((c) => dist(c, s.bg) > TOL.color)) issues.push({ viewport: vp, kind: 'color', detail: `section background rgb(${s.bg}) not used by the reference` });
  }
  // de-duplicate (the same finding is often reported by several sections)
  const seen = new Set(); const unique = issues.filter((i) => { const k = `${i.viewport}|${i.kind}|${i.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const real = unique.filter((i) => i.kind !== 'unmeasurable');
  if (!real.length && unique.length) return { verdict: 'unmeasurable', issues: unique, viewports };
  return { verdict: real.length ? 'regression' : 'match', issues: unique, viewports };
}

export const visualCheckEnabled = (env = process.env) => String(env.LIVE_DESIGN_VISUAL ?? 'on').toLowerCase() !== 'off';
