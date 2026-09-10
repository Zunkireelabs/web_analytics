// A pre-ship check on RESPONSIVE layout — does the exact content about to be
// spliced into a real live page keep working at mobile/tablet widths, not
// just on the 1440px desktop view every other gate implicitly checks against.
//
// WHY THIS EXISTS
//
// design-drift.js's checkTemplateStructuralMatch (2026-09-10) closed the gap
// where a captured template's classes were all real but its STRUCTURE didn't
// match the site. That check, like every other gate in this pipeline, only
// ever looks at the page as a static document — it has no concept of what
// happens when the viewport gets narrow. A component whose desktop markup and
// classes are both genuinely correct can still overflow, get clipped, or turn
// its tap targets unusably small at a phone width; nothing upstream of this
// module can see that, because none of it renders a browser.
//
// This does: it takes the REAL final HTML a draft is about to publish (the
// exact string marker-merge.js's buildMergeValues would splice in — not a
// re-derivation, not a guess), splices it into a live copy of the real
// target page in a headless browser, and measures the SAME responsive facts
// design-agent/live-analysis/capture.js's measureResponsiveInPage already
// knows how to detect (horizontal overflow, clipped content, undersized tap
// targets) — reused directly rather than a second implementation of the same
// check.
//
// BEFORE/AFTER, NOT ABSOLUTE. A page can already have a pre-existing
// responsive defect this draft had nothing to do with (a site's own nav that
// has always overflowed at 390px, say) — flagging that as this draft's fault
// would be exactly the kind of false confidence the structural-match fix
// exists to prevent, just aimed the other way. So every viewport is measured
// TWICE: once on the real live page as it stands today (the baseline), once
// again immediately after the draft's content is spliced in (in the SAME
// browser tab, via DOM mutation — no second navigation, so both measurements
// see identical everything else). Only a REGRESSION between the two — this
// draft made something worse that wasn't already broken — is reported.
//
// Deliberately NOT wired as a hard block by default (see checkResponsivePreview's
// own `ok`/`broken` contract) — same "informational, caller decides" posture
// checkDesignIntegrityGate already uses, so a caller can log-and-ship during
// rollout and only start refusing once the signal has been watched for false
// positives on real traffic.
import { launchBrowser, DESKTOP_VIEWPORT, RESPONSIVE_VIEWPORTS, measureResponsiveInPage } from '../../design-agent/live-analysis/capture.js';

const NAV_TIMEOUT_MS = Number(process.env.RESPONSIVE_PREVIEW_NAV_TIMEOUT_MS) || 20_000;

// Runs IN-PAGE (serialized via page.evaluate, same convention as
// capture.js's own measureResponsiveInPage) — finds the SEOAI marker's
// START/END comment nodes in the live DOM and replaces everything between
// them with `html`. Comment-node search, not a string/innerHTML replace on
// the whole document: mutating only the nodes between two specific comments
// is the one operation that can never touch anything outside the marker,
// the same "only bytes between START/END are ever rewritten" safety
// repair-site-marker-styling.js already relies on for the real, on-disk
// case. Returns false (never throws) when the marker isn't present on this
// page at all — a brand-new insertion has nothing "before" to preview
// against, which the caller treats as skip, not a failure.
/* eslint-disable no-undef */
function injectMarkerContent([marker, html]) {
  const startLabel = `SEOAI:${marker}:START`;
  const endLabel = `SEOAI:${marker}:END`;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
  let startNode = null;
  let endNode = null;
  let node = walker.nextNode();
  while (node) {
    const text = node.data.trim();
    if (!startNode && text === startLabel) startNode = node;
    else if (startNode && !endNode && text === endLabel) { endNode = node; break; }
    node = walker.nextNode();
  }
  if (!startNode || !endNode) return false;

  let cur = startNode.nextSibling;
  while (cur && cur !== endNode) {
    const next = cur.nextSibling;
    cur.remove();
    cur = next;
  }
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const frag = document.createDocumentFragment();
  while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);
  startNode.parentNode.insertBefore(frag, endNode);
  return true;
}
/* eslint-enable no-undef */

const MIN_TAP_TARGET_PX = 24;
// A handful of px of slack before something counts as a real regression —
// sub-pixel rendering differences between two measurements of the same
// static page are real and must not read as this draft's fault.
const OVERFLOW_TOLERANCE_PX = 2;

function diffMeasurement(before, after, viewport) {
  const regressions = [];
  if (after.overflowPx > before.overflowPx + OVERFLOW_TOLERANCE_PX) {
    regressions.push({
      viewport: viewport.name, width: viewport.width, kind: 'horizontal-overflow',
      overflowPx: after.overflowPx, wasAlready: before.overflowPx,
      elements: after.overflowingElements,
    });
  }
  const beforeClipped = new Set(before.clippedElements.map((e) => e.outerHtml));
  const newClipped = after.clippedElements.filter((e) => !beforeClipped.has(e.outerHtml));
  if (newClipped.length) {
    regressions.push({ viewport: viewport.name, width: viewport.width, kind: 'clipped-content', elements: newClipped });
  }
  const beforeSmall = new Set(before.smallTapTargets.map((e) => e.outerHtml));
  const newSmall = after.smallTapTargets.filter((e) => !beforeSmall.has(e.outerHtml));
  if (newSmall.length) {
    regressions.push({ viewport: viewport.name, width: viewport.width, kind: 'undersized-tap-target', elements: newSmall });
  }
  return regressions;
}

/**
 * @param {object} opts
 * @param {string} opts.pageUrl the real live page this content is about to publish to
 * @param {string} opts.marker the SEOAI marker name (e.g. 'FAQ', 'QACONTENT') this draft splices into
 * @param {string} opts.newContentHtml the exact final HTML string being spliced in — the same value buildMergeValues produces
 * @param {Array<{name,width,height}>} [opts.viewports] defaults to desktop + the same tablet/mobile viewports capture.js's design profiling already uses
 * @returns {{ ok: boolean, skip?: boolean, reason?: string, error?: string, broken?: boolean, regressions?: object[] }}
 */
export async function checkResponsivePreview({
  pageUrl, marker, newContentHtml,
  viewports = [DESKTOP_VIEWPORT, ...RESPONSIVE_VIEWPORTS],
  launchBrowserFn = launchBrowser,
} = {}) {
  if (!pageUrl || !marker || newContentHtml == null) {
    return { ok: false, error: 'pageUrl, marker and newContentHtml are all required.' };
  }

  let browser;
  try {
    browser = await launchBrowserFn();
  } catch (err) {
    // Infra failure, not evidence anything is broken — same fail-open
    // discipline every other live-site check in this pipeline uses.
    return { ok: false, reason: 'unreachable', error: `Could not launch a browser to preview this change: ${err.message}` };
  }

  try {
    const context = await browser.newContext({ viewport: { width: viewports[0].width, height: viewports[0].height } });
    const page = await context.newPage();

    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      return { ok: false, reason: 'unreachable', error: `Could not load ${pageUrl} to preview this change: ${err.message}` };
    }

    const before = {};
    for (const vp of viewports) {
      // eslint-disable-next-line no-await-in-loop
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // eslint-disable-next-line no-await-in-loop
      before[vp.name] = await page.evaluate(measureResponsiveInPage, MIN_TAP_TARGET_PX);
    }

    const injected = await page.evaluate(injectMarkerContent, [marker, newContentHtml]);
    if (!injected) {
      return { ok: true, skip: true, reason: 'no-marker-found' };
    }

    const regressions = [];
    for (const vp of viewports) {
      // eslint-disable-next-line no-await-in-loop
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // eslint-disable-next-line no-await-in-loop
      const after = await page.evaluate(measureResponsiveInPage, MIN_TAP_TARGET_PX);
      regressions.push(...diffMeasurement(before[vp.name], after, vp));
    }

    return { ok: true, broken: regressions.length > 0, regressions };
  } catch (err) {
    return { ok: false, reason: 'unreachable', error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

// A short, human-readable summary of `regressions` — same "one honest
// sentence, not a data dump" convention checkTemplateFreshness's own error
// strings use, so a caller (backend.js's apply gate, an Action Center
// warning) can surface this directly without re-deriving English from the
// structured array itself.
export function describeResponsiveRegressions(regressions) {
  if (!regressions?.length) return null;
  return regressions.map((r) => {
    const at = `at ${r.width}px (${r.viewport})`;
    if (r.kind === 'horizontal-overflow') return `new horizontal overflow ${at} — ${r.overflowPx}px wider than the viewport`;
    if (r.kind === 'clipped-content') return `content newly clipped ${at} (${r.elements.length} element(s))`;
    return `${r.elements.length} new undersized tap target(s) ${at}`;
  }).join('; ');
}
