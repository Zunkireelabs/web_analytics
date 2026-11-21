// AUTONOMOUS DESIGN REPAIR — one shared mechanism for every agent that creates,
// modifies or renders a website page.
//
// The pipeline already had detectors (the layout gate, the new-page render gate,
// design completeness, live design validation) and a few repair behaviours, but
// they were separate, and a gate that only says "no" makes a person the repair
// loop. This module is the loop:
//
//   DETECT -> DIAGNOSE -> IDENTIFY OWNER -> REPAIR -> RE-RENDER -> REVALIDATE
//          -> LEARN -> (caller) SHIP
//
// DIAGNOSE compares what the draft actually rendered against the original site
// — DOM wrappers and classes, computed typography, line length, spacing — and
// names a root cause and WHO OWNS IT, because a rewrite can only fix one of the
// four kinds of cause:
//
//   generator          the draft's own content is the problem (inline sizing,
//                      an unbreakable token, a stray <h1>...). The responsible
//                      generator regenerates with the element-level evidence.
//   shared-renderer    the platform's markup projection lost something the
//                      site's CSS depends on (a wrapper, body-element classes).
//                      A rewrite can't change that: engineering repair does.
//   design-capture     the captured picture of the site is incomplete or stale.
//                      The Design Agent re-captures from the live site.
//   validation-gate    the gate cannot reproduce the site's own rendering: put
//                      the site's OWN body back through it and it still fails.
//                      The check is wrong, not the draft. Engineering repair.
//
// What this never does: change the client's website, loosen a threshold, switch
// a gate to log-only, or ship a draft that failed. A failing result is only ever
// returned as a failure, with the evidence and what was tried.
import { launchBrowser } from '../../design-agent/live-analysis/capture.js';
import {
  measureBodyInPage, injectBodyInPage, compareBodyMeasures, MEASURE_VIEWPORTS,
} from '../../design-agent/live-analysis/body-measure.js';
import { injectMarkerContent } from './responsive-preview-gate.js';

export const OWNER = Object.freeze({
  GENERATOR: 'generator',
  SHARED_RENDERER: 'shared-renderer',
  DESIGN_CAPTURE: 'design-capture',
  VALIDATION_GATE: 'validation-gate',
});

// Maximum automatic repair attempts per draft, including the first real check.
export const MAX_REPAIR_ATTEMPTS = 3;

// How many earlier runs may already have deferred this same item to its owner before it goes to a person. A deferral
// is only honest while someone is acting on it; this is what stops "retry later" from becoming "retry forever".
export const MAX_DEFERRALS = 3;

// The failure reasons a design repair can act on. Everything else (a missing
// file mapping, an unconfigured marker, a GitHub outage) is not a design
// problem and is passed straight back unchanged.
export const REPAIRABLE_REASONS = new Set([
  'responsive-regression',
  'render-deviation',
  'design-incomplete',
]);

// What each owner's hand-off is reported as, so the attempt is retried once the
// platform change lands instead of being counted against the item.
export const PENDING_REASON = Object.freeze({
  [OWNER.DESIGN_CAPTURE]: 'design-capture-refresh-pending',
  [OWNER.SHARED_RENDERER]: 'shared-code-repair-pending',
  [OWNER.VALIDATION_GATE]: 'shared-code-repair-pending',
});

// ---------------------------------------------------------------------------
// Pure helpers (no browser): content hazards and the ownership decision.
// ---------------------------------------------------------------------------

// Things the DRAFT itself contains that break layout whatever the site's CSS
// is. Only these are the generator's to fix by rewriting.
export function scanDraftHazards(html) {
  const src = String(html || '');
  const hazards = [];
  const inline = src.match(/<[a-z][^>]*\sstyle\s*=\s*"[^"]*(?:font-size|width|max-width|margin|padding|line-height)[^"]*"/gi) || [];
  if (inline.length) hazards.push({ kind: 'inline-sizing', detail: `${inline.length} element(s) set their own size/spacing inline, overriding the site's typography` });
  if (/<h1[\s>]/i.test(src)) hazards.push({ kind: 'stray-h1', detail: 'the body contains an <h1>; the page template already provides the page title' });
  const text = src.replace(/<[^>]*>/g, ' ');
  const longToken = text.split(/\s+/).find((w) => w.length > 60 && !/^https?:\/\//i.test(w));
  if (longToken) hazards.push({ kind: 'unbreakable-token', detail: `a ${longToken.length}-character string with no break points can overflow its column` });
  if (/<table[\s>]/i.test(src) && !/<div[^>]*overflow/i.test(src)) hazards.push({ kind: 'bare-table', detail: 'a table with no scrolling wrapper can overflow narrow viewports' });
  if (/<iframe[\s>]/i.test(src)) hazards.push({ kind: 'iframe', detail: 'an embedded frame has no intrinsic size inside the site\'s column' });
  return hazards;
}

// The ownership decision, from evidence only. Order matters: a specific,
// measured fact beats a general one.
//   1. the gate cannot reproduce the site's own page      -> validation-gate
//   2. the captured design is incomplete / unreadable     -> design-capture
//   3. the draft carries a layout hazard of its own       -> generator
//   4. the site's body elements carry classes the draft's
//      markup lost, and the platform produced that markup -> shared-renderer
//   5. otherwise: only the draft's content is left to change -> generator
export function decideOwner({ reason, gateControl = null, hazards = [], missingClasses = [], outsideWrappers = [], styleDeviations = [], producedBy = 'renderer' } = {}) {
  if (gateControl && gateControl.reproduced === false) {
    return {
      owner: OWNER.VALIDATION_GATE,
      cause: 'the check does not reproduce the site\'s own rendering: putting the page\'s own body back through the gate still reports a deviation',
    };
  }
  if (reason === 'design-incomplete' || /^(group-)?sample-/.test(String(reason || ''))) {
    return { owner: OWNER.DESIGN_CAPTURE, cause: 'the captured design of this site does not cover what the page renders, or could not be read' };
  }
  if (hazards.length) {
    return { owner: OWNER.GENERATOR, cause: `the draft's own content breaks layout: ${hazards.map((h) => h.kind).join(', ')}` };
  }
  if (missingClasses.length && producedBy === 'renderer') {
    return {
      owner: OWNER.SHARED_RENDERER,
      cause: `the site's body elements carry classes (${missingClasses.slice(0, 6).join(', ')}) that the rendered markup does not, so the site's own CSS cannot apply`,
    };
  }
  // The block was spliced in OUTSIDE the wrapper the page's own paragraphs sit in, AND it renders differently from them:
  // the site's typography cannot reach it however the content is written. Placement belongs to the shared insertion code.
  if (outsideWrappers.length && styleDeviations.length && producedBy === 'renderer') {
    return {
      owner: OWNER.SHARED_RENDERER,
      cause: `the block is placed outside the wrapper (${outsideWrappers.slice(0, 3).join(' < ')}) that the page's own paragraphs sit in, so the site's typography cannot apply to it`,
    };
  }
  return { owner: OWNER.GENERATOR, cause: 'the draft renders differently from the site and nothing outside its content explains it' };
}

const describeStyleDeviation = (d) => `<${d.tag}> ${d.property}: the page's own elements are ${d.page}${d.property === 'font-size' || d.property === 'spacing-below' ? 'px' : ''}, the block's are ${d.block}${d.property === 'font-size' || d.property === 'spacing-below' ? 'px' : ''} (${d.viewport})`;
const describeDeviation = (d) => `${d.kind}: the site renders ${d.expected}, the draft ${d.actual} (${d.viewport})`;

function describeRegression(r) {
  const at = `${r.width}px (${r.viewport})`;
  if (r.kind === 'horizontal-overflow') return `horizontal overflow at ${at}: ${r.overflowPx}px wider than the screen`;
  const first = r.elements?.[0];
  const el = first?.tag ? ` — first offender <${first.tag}>${first.text ? ` "${String(first.text).slice(0, 40)}"` : ''}` : '';
  return `${r.kind === 'clipped-content' ? 'content clipped' : 'undersized tap targets'} at ${at}${el}`;
}

// What the generator is told. Element-level, not "something was off".
export function buildCorrection({ diagnosis, failure }) {
  const lines = [];
  for (const d of failure?.deviations || []) lines.push(`- ${describeDeviation(d)}`);
  for (const r of failure?.regressions || []) lines.push(`- ${describeRegression(r)}`);
  for (const h of diagnosis.hazards || []) lines.push(`- ${h.detail}`);
  for (const d of diagnosis.styleDeviations || []) lines.push(`- ${describeStyleDeviation(d)}`);
  return 'CORRECTION REQUIRED — the previous version was rendered into the site\'s real page and compared with how the site '
    + 'itself looks. Root cause found: ' + diagnosis.cause + '.\n'
    + (lines.length ? `Measured:\n${lines.join('\n')}\n` : '')
    + 'Fix exactly this in the CONTENT: no inline styles or sizing, no <h1>, no unbreakable strings, no tables or embeds that '
    + 'cannot wrap. Do not change anything else you already wrote.';
}

export function summarizeDiagnosis(d) {
  if (!d) return '';
  const owners = {
    [OWNER.GENERATOR]: 'the draft\'s content',
    [OWNER.SHARED_RENDERER]: 'the platform\'s shared page renderer',
    [OWNER.DESIGN_CAPTURE]: 'the captured design of this site',
    [OWNER.VALIDATION_GATE]: 'the validation check itself',
  };
  return `Root cause (${owners[d.owner] || d.owner}): ${d.cause}.`;
}

// ---------------------------------------------------------------------------
// Browser half: read the site's real page and the draft's markup side by side.
// ---------------------------------------------------------------------------

// Runs INSIDE the page after measureBodyInPage(mark=true) has marked the body
// region. Self-contained: no imports, no closures.
/* eslint-disable no-undef */
export function inspectBodyInPage(draftHtml) {
  const region = document.querySelector('[data-gate-region]');
  if (!region) return { found: false };
  const tokens = (el) => String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const siteTokens = new Set();
  for (const el of region.querySelectorAll('p, h2, h3, ul, ol, li, blockquote, a, table')) tokens(el).forEach((t) => siteTokens.add(t));
  const tpl = document.createElement('template');
  tpl.innerHTML = draftHtml;
  const draftTokens = new Set();
  for (const el of tpl.content.querySelectorAll('*')) tokens(el).forEach((t) => draftTokens.add(t));
  const chain = [];
  for (let el = region; el && el !== document.body && chain.length < 6; el = el.parentElement) {
    chain.push(el.tagName.toLowerCase() + (tokens(el).length ? `.${tokens(el).slice(0, 3).join('.')}` : ''));
  }
  return { found: true, regionChain: chain, missingClasses: [...siteTokens].filter((t) => !draftTokens.has(t)), ownHtml: region.innerHTML };
}
/* eslint-enable no-undef */

async function inspectInBrowser({ referenceUrl, draftHtml, launchBrowserFn, navTimeoutMs = 20000 }) {
  let browser;
  try { browser = await launchBrowserFn(); } catch { return { ok: false, reason: 'browser-unavailable' }; }
  try {
    const context = await browser.newContext({ viewport: { width: MEASURE_VIEWPORTS[0].width, height: MEASURE_VIEWPORTS[0].height } });
    const page = await context.newPage();
    try { await page.goto(referenceUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }); } catch { return { ok: false, reason: 'unreachable' }; }

    const ref = {};
    for (const vp of MEASURE_VIEWPORTS) {
      // eslint-disable-next-line no-await-in-loop
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // eslint-disable-next-line no-await-in-loop
      ref[vp.name] = await page.evaluate(measureBodyInPage, true);
    }
    if (!ref[MEASURE_VIEWPORTS[0].name]?.found) return { ok: false, reason: 'no-body-region' };

    const signature = await page.evaluate(inspectBodyInPage, draftHtml);

    // CONTROL: put the site's OWN body back through the same injection and
    // measurement. A correct check must report nothing. If it still reports a
    // deviation, the draft is not the problem.
    await page.evaluate(injectBodyInPage, signature.ownHtml);
    const controlDeviations = [];
    for (const vp of MEASURE_VIEWPORTS) {
      // eslint-disable-next-line no-await-in-loop
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // eslint-disable-next-line no-await-in-loop
      const after = await page.evaluate(measureBodyInPage, false);
      controlDeviations.push(...compareBodyMeasures(ref[vp.name], after, vp));
    }
    return {
      ok: true,
      regionChain: signature.regionChain,
      missingClasses: signature.missingClasses,
      gateControl: { reproduced: controlDeviations.length === 0, deviations: controlDeviations },
    };
  } catch {
    return { ok: false, reason: 'inspect-failed' };
  } finally {
    await browser.close().catch(() => {});
  }
}


// EXISTING-PAGE PATH. A block spliced into a live page between SEOAI markers has no "region" to swap, so it is judged
// against the page's OWN elements around it — the same tag, outside the block — at the same standard as a new page:
// wrappers, classes and computed styles, at every viewport. Runs inside the page after the block has been injected.
// Self-contained: no imports, no closures.
/* eslint-disable no-undef */
export function inspectMarkerInPage([marker, viewportName]) {
  const startLabel = `SEOAI:${marker}:START`;
  const endLabel = `SEOAI:${marker}:END`;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
  let start = null; let end = null; let node = walker.nextNode();
  while (node) {
    const text = node.data.trim();
    if (!start && text === startLabel) start = node;
    else if (start && !end && text === endLabel) { end = node; break; }
    node = walker.nextNode();
  }
  if (!start || !end) return { found: false };
  const block = [];
  for (let c = start.nextSibling; c && c !== end; c = c.nextSibling) if (c.nodeType === 1) block.push(c);
  if (!block.length) return { found: false };
  const inBlock = (el) => block.some((b) => b === el || b.contains(el));
  const tokens = (el) => String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const sel = (el) => el.tagName.toLowerCase() + (tokens(el).length ? `.${tokens(el).slice(0, 3).join('.')}` : '');
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const first = (v) => String(v || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  const read = (el) => {
    const cs = getComputedStyle(el);
    const fontSize = px(cs.fontSize);
    const lh = cs.lineHeight === 'normal' ? fontSize * 1.2 : px(cs.lineHeight);
    return {
      fontSize, lineHeight: fontSize ? Math.round((lh / fontSize) * 100) / 100 : 0, fontWeight: String(cs.fontWeight),
      fontFamily: first(cs.fontFamily), color: cs.color, marginBottom: px(cs.marginBottom), width: el.getBoundingClientRect().width,
    };
  };
  const median = (arr) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const mode = (arr) => { const m = new Map(); for (const v of arr) m.set(v, (m.get(v) || 0) + 1); return [...m].sort((x, y) => y[1] - x[1])[0]?.[0]; };
  const off = (a, b, tol) => (a > 0 && b > 0 ? Math.abs(b - a) / a > tol : false);

  const missing = new Set();
  const styleDeviations = [];
  for (const tag of ['p', 'h2', 'h3']) {
    const page = [...document.body.querySelectorAll(tag)]
      .filter((e) => !inBlock(e) && (e.textContent || '').trim().length > 0 && e.getBoundingClientRect().width > 0).slice(0, 60);
    const mine = block.flatMap((b) => [...(b.matches(tag) ? [b] : []), ...b.querySelectorAll(tag)]);
    if (page.length < 3 || !mine.length) continue;

    // CLASSES. Only a tag the block leaves COMPLETELY bare counts: a block that styles its own headings differently on
    // purpose (a FAQ question as <h3 class="faq-q">) is not "markup that lost the site's classes".
    if (mine.every((e) => tokens(e).length === 0)) {
      const freq = new Map();
      for (const e of page) for (const t of new Set(tokens(e))) freq.set(t, (freq.get(t) || 0) + 1);
      for (const [t, n] of freq) if (n >= page.length / 2) missing.add(t);
    }

    // COMPUTED STYLES, the site's own typical value against the block's.
    const site = page.map(read);
    const own = read(mine[0]);
    const add = (property, pageValue, blockValue) => styleDeviations.push({ tag, property, page: pageValue, block: blockValue, viewport: viewportName });
    const sizeTol = tag === 'p' ? 0.1 : 0.15;
    if (off(median(site.map((x) => x.fontSize)), own.fontSize, sizeTol)) add('font-size', median(site.map((x) => x.fontSize)), own.fontSize);
    if (off(median(site.map((x) => x.lineHeight)), own.lineHeight, 0.12)) add('line-height', median(site.map((x) => x.lineHeight)), own.lineHeight);
    if (mode(site.map((x) => x.fontWeight)) !== undefined && mode(site.map((x) => x.fontWeight)) !== own.fontWeight) add('font-weight', mode(site.map((x) => x.fontWeight)), own.fontWeight);
    if (mode(site.map((x) => x.fontFamily)) && mode(site.map((x) => x.fontFamily)) !== own.fontFamily) add('font-family', mode(site.map((x) => x.fontFamily)), own.fontFamily);
    if (mode(site.map((x) => x.color)) && mode(site.map((x) => x.color)) !== own.color) add('colour', mode(site.map((x) => x.color)), own.color);
    const gap = median(site.map((x) => x.marginBottom));
    if (Math.abs(own.marginBottom - gap) > 4 && off(gap, own.marginBottom, 0.35)) add('spacing-below', gap, own.marginBottom);
    // LINE LENGTH — only paragraphs: the width of one line of body text. A block that fills the column where the
    // site's paragraphs are held to a narrower measure reads as a different design.
    if (tag === 'p' && off(median(site.map((x) => x.width)), own.width, 0.25)) add('line-length', Math.round(median(site.map((x) => x.width))), Math.round(own.width));
  }

  // WRAPPERS. The site's typography usually hangs on a wrapper around its body paragraphs. If the block sits OUTSIDE
  // that wrapper, its paragraphs cannot pick the typography up however well they are written.
  const pagePs = [...document.body.querySelectorAll('p')].filter((p) => !inBlock(p) && (p.textContent || '').trim().length > 40);
  const byParent = new Map();
  for (const p of pagePs) byParent.set(p.parentElement, (byParent.get(p.parentElement) || 0) + 1);
  const proseParent = [...byParent].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
  const outsideWrappers = [];
  if (proseParent && !proseParent.contains(block[0])) {
    for (let a = proseParent; a && a !== document.body; a = a.parentElement) if (!a.contains(block[0])) outsideWrappers.push(sel(a));
  }
  const chain = [];
  for (let el = block[0].parentElement; el && el !== document.body && chain.length < 5; el = el.parentElement) chain.push(sel(el));
  return {
    found: true, missingClasses: [...missing], styleDeviations, outsideWrappers,
    blockChain: chain, pageProseChain: proseParent ? (() => { const c = []; for (let el = proseParent; el && el !== document.body && c.length < 5; el = el.parentElement) c.push(sel(el)); return c; })() : [],
  };
}
/* eslint-enable no-undef */

async function inspectMarkerInBrowser({ pageUrl, marker, draftHtml, launchBrowserFn, navTimeoutMs = 20000 }) {
  let browser;
  try { browser = await launchBrowserFn(); } catch { return { ok: false, reason: 'browser-unavailable' }; }
  try {
    const context = await browser.newContext({ viewport: { width: MEASURE_VIEWPORTS[0].width, height: MEASURE_VIEWPORTS[0].height } });
    const page = await context.newPage();
    try { await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }); } catch { return { ok: false, reason: 'unreachable' }; }
    if (!(await page.evaluate(injectMarkerContent, [marker, draftHtml]))) return { ok: false, reason: 'no-marker-found' };
    const missing = new Set(); const outside = new Set(); const styleDeviations = []; let chains = null;
    for (const vp of MEASURE_VIEWPORTS) {
      // eslint-disable-next-line no-await-in-loop
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // eslint-disable-next-line no-await-in-loop
      const found = await page.evaluate(inspectMarkerInPage, [marker, vp.name]);
      if (!found.found) return { ok: false, reason: 'no-marker-found' };
      found.missingClasses.forEach((c) => missing.add(c));
      found.outsideWrappers.forEach((c) => outside.add(c));
      styleDeviations.push(...found.styleDeviations);
      chains ||= { blockChain: found.blockChain, pageProseChain: found.pageProseChain };
    }
    return { ok: true, missingClasses: [...missing], outsideWrappers: [...outside], styleDeviations, ...chains, gateControl: null, regionChain: [] };
  } catch {
    return { ok: false, reason: 'inspect-failed' };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Find the root cause of a failed design check and who owns it.
 *
 * @param {object} p
 * @param {{reason:string, deviations?:object[], regressions?:object[], referenceUrl?:string}} p.failure
 * @param {string} p.draftHtml the exact markup that was rendered
 * @param {'renderer'|'generator'} [p.producedBy] who produced the markup's structure
 * @returns {Promise<{owner, cause, evidence:string[], hazards:object[], correction:string, summary:string, inspected:boolean}>}
 */
export async function diagnoseDesignFailure({
  failure, draftHtml, producedBy = 'renderer', launchBrowserFn = launchBrowser,
  inspectFn = inspectInBrowser, inspectMarkerFn = inspectMarkerInBrowser,
} = {}) {
  const hazards = scanDraftHazards(draftHtml);
  let inspection = null;
  const referenceUrl = failure?.referenceUrl;
  if (failure?.reason === 'render-deviation' && referenceUrl && draftHtml != null) {
    // NEW-PAGE PATH: swap the body into the site's real page and compare wrappers, classes and typography.
    inspection = await inspectFn({ referenceUrl, draftHtml, launchBrowserFn }).catch(() => ({ ok: false, reason: 'inspect-failed' }));
  } else if (failure?.reason === 'responsive-regression' && failure.pageUrl && failure.marker && draftHtml != null) {
    // EXISTING-PAGE PATH: splice the block in and compare it with the page's own elements around it.
    inspection = await inspectMarkerFn({ pageUrl: failure.pageUrl, marker: failure.marker, draftHtml, launchBrowserFn }).catch(() => ({ ok: false, reason: 'inspect-failed' }));
  }
  const ok = inspection?.ok === true;
  const { owner, cause } = decideOwner({
    reason: failure?.reason,
    gateControl: ok ? (inspection.gateControl ?? null) : null,
    hazards,
    missingClasses: ok ? (inspection.missingClasses || []) : [],
    outsideWrappers: ok ? (inspection.outsideWrappers || []) : [],
    styleDeviations: ok ? (inspection.styleDeviations || []) : [],
    producedBy,
  });
  const evidence = [
    ...(failure?.deviations || []).map(describeDeviation),
    ...(failure?.regressions || []).map(describeRegression),
    ...hazards.map((h) => h.detail),
    ...(ok && inspection.missingClasses?.length ? [`classes on the site's own elements that the draft lacks: ${inspection.missingClasses.slice(0, 8).join(', ')}`] : []),
    ...(ok && inspection.gateControl && inspection.gateControl.reproduced === false ? [`the site's own body, put back through the check, still reported: ${inspection.gateControl.deviations.map(describeDeviation).join('; ')}`] : []),
    ...(ok && inspection.regionChain?.length ? [`body region on the site: ${inspection.regionChain.join(' < ')}`] : []),
    ...(ok ? (inspection.styleDeviations || []).map(describeStyleDeviation) : []),
    ...(ok && inspection.outsideWrappers?.length ? [`the block sits outside ${inspection.outsideWrappers.slice(0, 3).join(' < ')}, which holds the page's own paragraphs${inspection.blockChain?.length ? ` (the block is in ${inspection.blockChain.join(' < ')})` : ''}`] : []),
  ];
  const diagnosis = { owner, cause, evidence, hazards, inspected: ok, styleDeviations: ok ? (inspection.styleDeviations || []) : [] };
  return { ...diagnosis, correction: buildCorrection({ diagnosis, failure }), summary: summarizeDiagnosis(diagnosis) };
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

/**
 * Check, diagnose, route to the owner, repair, re-check — at most
 * `maxAttempts` real checks — and report. NEVER reports success for content
 * whose last check failed.
 *
 * @param {object} p
 * @param {*}        p.content        the draft content as it stands
 * @param {(content:*)=>Promise<object>} p.check  runs the real validation; `{ok:true,...}` or `{ok:false, reason, deviations?, regressions?, referenceUrl?, ...}`
 * @param {(correction:string, diagnosis:object)=>Promise<*|null>} p.regenerate  the generator's repair; resolves the NEW content, or null if it cannot
 * @param {(content:*, result:object)=>string} [p.draftHtmlOf]  the markup a check rendered
 * @param {'renderer'|'generator'} [p.producedBy]
 * @param {{designCapture?:Function, sharedCode?:Function}} [p.handoff] owner hand-offs; each gets (diagnosis, failedResult) and resolves { requested:boolean, detail:string } — `requested:false` (or throwing) means nobody took it, which is reported as exhausted, never as deferred
 * @param {Function} [p.learn] ({outcome, diagnosis, attempts}) records the lesson; failures here never affect the result
 * @param {number} [p.priorDeferrals] earlier runs that already deferred this item; at MAX_DEFERRALS it goes to a person
 * @param {Function} [p.diagnose] override (tests)
 * @returns {Promise<{status, ok:boolean, content:*, result:object, diagnosis:object|null, attempts:object[], pendingReason?:string}>}
 *   status: 'passed' | 'passed-after-repair' | 'not-repairable' | 'deferred' | 'exhausted'
 */
export async function investigateAndRepairDesign({
  content, check, regenerate, draftHtmlOf = (c) => (typeof c === 'string' ? c : ''), producedBy = 'renderer',
  handoff = {}, learn = null, diagnose = diagnoseDesignFailure, maxAttempts = MAX_REPAIR_ATTEMPTS, priorDeferrals = 0,
  isRepairable = (r) => REPAIRABLE_REASONS.has(r?.reason),
} = {}) {
  const attempts = [];
  let current = content;
  let result = await check(current);
  let diagnosis = null;

  const finish = async (status, extra = {}) => {
    const ok = status === 'passed' || status === 'passed-after-repair';
    if (learn && (diagnosis || ok) && attempts.length) {
      await Promise.resolve(learn({ outcome: ok ? 'fixed' : status, diagnosis, attempts, failure: result })).catch(() => {});
    }
    return { status, ok, content: current, result, diagnosis, attempts, ...extra };
  };

  if (result?.ok) return { status: 'passed', ok: true, content: current, result, diagnosis: null, attempts };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!isRepairable(result)) return finish('not-repairable');

    // eslint-disable-next-line no-await-in-loop
    diagnosis = await diagnose({ failure: result, draftHtml: draftHtmlOf(current, result), producedBy })
      .catch(() => ({ owner: OWNER.GENERATOR, cause: 'the cause could not be determined automatically', evidence: [], hazards: [], correction: buildCorrection({ diagnosis: { cause: 'unknown' }, failure: result }), summary: '' }));
    const entry = { attempt, owner: diagnosis.owner, cause: diagnosis.cause, evidence: diagnosis.evidence };
    attempts.push(entry);

    // A rewrite can only fix content. Anything else is handed to its owner and
    // the item is retried once their change lands — never counted against it.
    if (diagnosis.owner !== OWNER.GENERATOR) {
      const hook = diagnosis.owner === OWNER.DESIGN_CAPTURE ? handoff.designCapture : handoff.sharedCode;
      entry.action = diagnosis.owner === OWNER.DESIGN_CAPTURE ? 're-capture the site design' : 'open a shared-code repair';
      // A hand-off only counts if SOMEONE TOOK THE WORK. A deferral that nobody is acting on is the worst outcome — the
      // item would be retried forever against a cause no one is fixing — so a hook reports { requested, detail }, and a
      // refusal (feature off, no repo, already flagged, hook missing or failing) is an honest 'exhausted': a person gets
      // the diagnosis now instead of the item cycling silently.
      let taken = false;
      try {
        // Already waited this many runs for the owner to fix the cause: nobody has. Stop waiting.
        if (priorDeferrals >= MAX_DEFERRALS) {
          entry.handoff = `waited ${priorDeferrals} earlier run(s) for the cause to be fixed`;
          entry.outcome = `nobody could take this on automatically (${entry.handoff})`;
          // eslint-disable-next-line no-await-in-loop
          return finish('exhausted', { handedToPerson: true });
        }
        const reported = hook ? await hook(diagnosis, result) : null;
        if (reported && typeof reported === 'object') { taken = reported.requested === true; entry.handoff = reported.detail || (taken ? 'requested' : 'not requested'); }
        else { taken = false; entry.handoff = typeof reported === 'string' ? reported : 'no-handler'; }
      } catch { entry.handoff = 'failed'; }
      if (!taken) {
        entry.outcome = `nobody could take this on automatically (${entry.handoff})`;
        // eslint-disable-next-line no-await-in-loop
        return finish('exhausted', { handedToPerson: true });
      }
      // eslint-disable-next-line no-await-in-loop
      return finish('deferred', { pendingReason: PENDING_REASON[diagnosis.owner] });
    }

    if (attempt === maxAttempts) { entry.action = 'none (attempt limit reached)'; break; }

    entry.action = 'regenerate the content with the element-level evidence';
    // eslint-disable-next-line no-await-in-loop
    const repaired = await regenerate(diagnosis.correction, diagnosis).catch(() => null);
    if (repaired == null) { entry.outcome = 'the generator could not produce a repaired version'; break; }
    current = repaired;
    // eslint-disable-next-line no-await-in-loop
    result = await check(current);
    entry.outcome = result?.ok ? 'passed the re-check' : `still failing: ${result?.reason || 'unknown'}`;
    if (result?.ok) return finish('passed-after-repair');
  }
  return finish('exhausted');
}
