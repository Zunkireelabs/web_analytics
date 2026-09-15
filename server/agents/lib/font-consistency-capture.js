// Real, rendered font-size capture for font-consistency.js — font size is
// CSS-cascade-derived (a shared class, a stylesheet rule, a media query),
// so it can't be read reliably from a static fetch the way the rest of
// content-integrity.js works. This reuses the Design Agent's live-analysis
// browser plumbing (launchBrowser/discoverPages, server/design-agent/
// live-analysis/capture.js) — same headless Chromium, same page-type-
// diverse sample of real URLs — but runs its own lightweight in-page
// extraction: only headings/paragraphs, with each element's REAL computed
// font-size (window.getComputedStyle, the same ground truth a human eye
// would see) plus its raw inline style attribute and full outerHTML, which
// font-consistency-repair needs to tell a genuine CSS-class inconsistency
// (not safely auto-fixable) apart from a one-element inline override (is).
import { launchBrowser, discoverPages } from '../../design-agent/live-analysis/capture.js';
import { classifyPageType } from '../../design-agent/live-analysis/schema.js';
import { extractScopedFontSizeDeclaration } from './font-consistency-analysis.js';

const DEFAULT_MAX_PAGES = Number(process.env.DESIGN_AGENT_CAPTURE_MAX_PAGES) || 8;
const NAV_TIMEOUT_MS = Number(process.env.DESIGN_AGENT_CAPTURE_NAV_TIMEOUT_MS) || 20_000;
const MAX_PARAGRAPHS_PER_PAGE = 20;

/* eslint-disable no-undef */
function extractStyleSamplesInPage(maxParagraphs) {
  // The nearest ancestor carrying its own class — the real wrapper a
  // headless-of-its-own-class heading (a bare `<h1>`, styled entirely via
  // `.some-wrapper h1{...}` rather than a class on the element itself) is
  // actually scoped by. Needed because font-consistency-analysis.js's
  // existing class-swap fix has nothing to act on when the element itself
  // carries no class at all — this is what lets it instead recognize a
  // SCOPED ancestor-selector fix as safe (see that file's
  // ancestorClassIsPageUnique/buildScopedFontSizeFix).
  function nearestAncestorClass(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (typeof node.className === 'string' && node.className.trim()) {
        return node.className.trim().split(/\s+/)[0];
      }
      node = node.parentElement;
    }
    return null;
  }
  function sample(el, { captureAncestor = false } = {}) {
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    const classes = (el.className && typeof el.className === 'string') ? el.className.trim().slice(0, 300) : '';
    return {
      tag: el.tagName.toLowerCase(),
      classes,
      fontSize: cs.fontSize,
      inlineStyle: el.getAttribute('style') || null,
      outerHtml: el.outerHTML,
      text: el.textContent.trim().slice(0, 120),
      // Only meaningful (and only ever looked up) for a heading with no
      // class of its own — see extractStyleSamplesInPage's caller.
      ancestorClass: captureAncestor && !classes ? nearestAncestorClass(el) : null,
    };
  }
  const headings = [...document.querySelectorAll('h1, h2, h3, h4')].map((el) => sample(el, { captureAncestor: true })).filter(Boolean);
  const paragraphs = [...document.querySelectorAll('main p, article p, body > p')]
    .slice(0, maxParagraphs)
    .map((el) => sample(el))
    .filter(Boolean);
  return { headings, paragraphs };
}
/* eslint-enable no-undef */

export async function captureFontSamplePage(browserPage, url) {
  await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const { headings, paragraphs } = await browserPage.evaluate(extractStyleSamplesInPage, MAX_PARAGRAPHS_PER_PAGE);

  // The real authored CSS text (e.g. "clamp(40px,6vw,74px)"), never the
  // browser-resolved pixel number getComputedStyle above already captured —
  // needed to tell a plain, safely-swappable length apart from a fluid/
  // responsive expression this platform refuses to flatten (see
  // font-consistency-analysis.js's isFlatLength). `page.content()` is the
  // DOM's own live-serialized HTML, not a second network fetch — for this
  // class of static-site template, an inline <style> block's text content
  // round-trips through DOM serialization byte-for-byte (no template syntax
  // survives into rendered output for a plain CSS declaration), so this is
  // exactly what the real template source also contains.
  const headingsNeedingRaw = headings.filter((h) => h.ancestorClass);
  if (headingsNeedingRaw.length) {
    const html = await browserPage.content();
    for (const h of headingsNeedingRaw) {
      h.rawFontSizeDeclaration = extractScopedFontSizeDeclaration(html, h.ancestorClass, h.tag)?.value || null;
    }
  }

  // classifyPageType is a pure URL-shape heuristic (design-agent/live-analysis/
  // schema.js) — the same one the Design Agent's own capture already tags
  // every page with. Threading it through here is what lets
  // findFontSizeOutliers judge a template against ITS OWN majority instead of
  // one flat sitewide majority (see that file) — this site's own real page
  // shape, never a value carried over from another tenant.
  return { url, pageType: classifyPageType(url), headings, paragraphs };
}

// Orchestrates the whole-site capture for one agent run: discover a
// page-type-diverse set of real URLs (same bounded, non-exhaustive approach
// as the Design Agent's own captureSite), then sample each one's real
// rendered heading/paragraph font sizes.
//
// `extraUrls` is the rotation slice (font-consistency.js passes the same
// selectCandidatePages batch visual-quality.js uses). It exists because
// discoverPages alone re-crawls the SAME ~8 homepage-reachable pages every
// single run — deterministic by construction, since a homepage's own link
// order doesn't change — so before 2026-09-03 every other page on the site
// had never once had its typography checked. On a 177-page site that is 8
// pages of real coverage and 169 pages of none.
//
// The two sets are deliberately NOT interchangeable. findFontSizeOutliers
// derives "expected" from the majority size per element group across
// whatever it is given, so a pure rotation would move the baseline every
// day: the same page could read as the outlier on Monday and as the norm on
// Tuesday, purely from which other pages happened to be in that morning's
// slice. The discovered set stays in every run as the stable baseline that
// defines what "the rest of this site" looks like, and the rotating slice is
// measured against it. Anchors therefore need to outnumber any single day's
// rotation for the majority to stay meaningful — keep that in mind before
// raising the rotation size much past DEFAULT_MAX_PAGES.
export async function captureFontSamples(homepageUrl, {
  maxPages = DEFAULT_MAX_PAGES,
  launchBrowserFn = launchBrowser,
  extraUrls = [],
} = {}) {
  const browser = await launchBrowserFn();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const targets = await discoverPages(page, homepageUrl, { maxPages });

    // Anchors first, then the rotation slice with anchors removed — a URL in
    // both sets must be captured once, not twice: a duplicated page would
    // count twice toward the majority and quietly weight the baseline toward
    // whichever pages happen to be in today's rotation.
    const anchorUrls = targets.map((t) => t.url);
    const seen = new Set(anchorUrls);
    const urls = [...anchorUrls, ...extraUrls.filter((u) => !seen.has(u) && (seen.add(u), true))];

    const pages = [];
    for (const url of urls) {
      // eslint-disable-next-line no-await-in-loop
      const captured = await captureFontSamplePage(page, url).catch((err) => {
        console.warn(`[font-consistency/capture] could not capture ${url}: ${err.message}`);
        return null;
      });
      if (captured) pages.push(captured);
    }
    return pages;
  } finally {
    await browser.close();
  }
}
