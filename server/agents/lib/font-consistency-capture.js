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

const DEFAULT_MAX_PAGES = Number(process.env.DESIGN_AGENT_CAPTURE_MAX_PAGES) || 8;
const NAV_TIMEOUT_MS = Number(process.env.DESIGN_AGENT_CAPTURE_NAV_TIMEOUT_MS) || 20_000;
const MAX_PARAGRAPHS_PER_PAGE = 20;

/* eslint-disable no-undef */
function extractStyleSamplesInPage(maxParagraphs) {
  function sample(el) {
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      classes: (el.className && typeof el.className === 'string') ? el.className.trim().slice(0, 300) : '',
      fontSize: cs.fontSize,
      inlineStyle: el.getAttribute('style') || null,
      outerHtml: el.outerHTML,
      text: el.textContent.trim().slice(0, 120),
    };
  }
  const headings = [...document.querySelectorAll('h1, h2, h3, h4')].map(sample).filter(Boolean);
  const paragraphs = [...document.querySelectorAll('main p, article p, body > p')]
    .slice(0, maxParagraphs)
    .map(sample)
    .filter(Boolean);
  return { headings, paragraphs };
}
/* eslint-enable no-undef */

export async function captureFontSamplePage(browserPage, url) {
  await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const { headings, paragraphs } = await browserPage.evaluate(extractStyleSamplesInPage, MAX_PARAGRAPHS_PER_PAGE);
  return { url, headings, paragraphs };
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
