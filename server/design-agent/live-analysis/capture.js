// Live-site capture — the replacement for design_task.py's OpenHands/Docker
// repo read. Instead of checking out a tenant's source and asking an
// autonomous coding agent to infer their design system from JSX/CSS-in-JS,
// this loads the site's REAL rendered pages in a headless browser and reads
// the DOM + computed styles directly — the same ground truth a human eye
// would use, with no repo access, no container, and no Docker dependency.
//
// Two-step per site: discoverPages() finds a small, page-type-diverse set of
// real URLs to look at (homepage always, plus one example of each other
// page type it can find via same-origin links), then capturePage() loads
// each one and extracts a raw, unclassified block list — segment.js (a
// pure, browser-free module) turns that into the structured `sections` the
// design profile schema wants.
import { chromium } from 'playwright';
import { classifyPageType } from './schema.js';

const DEFAULT_MAX_PAGES = Number(process.env.DESIGN_AGENT_CAPTURE_MAX_PAGES) || 8;
const NAV_TIMEOUT_MS = Number(process.env.DESIGN_AGENT_CAPTURE_NAV_TIMEOUT_MS) || 20_000;

export async function launchBrowser() {
  return chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

// Runs in-page: collects every same-origin, non-anchor, non-file link
// reachable from nav/header/footer/body — the raw candidate set
// discoverPages then dedupes and classifies.
/* eslint-disable no-undef */
function collectLinksInPage() {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    out.push(href);
  }
  return out;
}
/* eslint-enable no-undef */

// Finds a small, page-type-diverse set of real URLs on this site: the
// homepage plus the first URL discovered for each OTHER page type, up to
// maxPages total. Deliberately not a full-site crawl — the goal is one good
// representative of each page-type pattern (homepage/service/location/
// landing/faq/blog-listing/blog-article/legal), not exhaustive coverage,
// so a big site stays a bounded, fast analysis.
export async function discoverPages(browserPage, homepageUrl, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  await browserPage.goto(homepageUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const rawLinks = await browserPage.evaluate(collectLinksInPage);

  const seen = new Set([homepageUrl]);
  const byType = new Map([['homepage', homepageUrl]]);

  for (const href of rawLinks) {
    let abs;
    try { abs = new URL(href, homepageUrl).href.split('#')[0]; } catch { continue; }
    if (!sameOrigin(abs, homepageUrl) || seen.has(abs)) continue;
    if (/\.(pdf|jpg|jpeg|png|svg|gif|zip|css|js|xml)$/i.test(abs)) continue;
    seen.add(abs);
    const type = classifyPageType(abs);
    if (!byType.has(type)) byType.set(type, abs);
    if (byType.size >= maxPages) break;
  }

  return [...byType.entries()].map(([pageType, url]) => ({ url, pageType }));
}

// Runs in-page: walks the direct structural children of <body> (treating
// <header>/<nav>/<main>/<footer> as transparent wrappers whose OWN direct
// children are the real blocks), and for each one, reads its bounding rect
// plus the computed style of its first heading and first paragraph/list —
// the two style samples every projector and the extraction prompt actually
// need, without serializing the whole subtree's markup back to Node.
/* eslint-disable no-undef */
function extractBlocksInPage() {
  function styleOf(el) {
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    return {
      fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight, color: cs.color, textAlign: cs.textAlign,
      // textTransform/letterSpacing are what separate a body paragraph from an
      // eyebrow/kicker label — see isLabelLike. Without them, downstream role
      // assignment has no framework-agnostic signal to tell the two apart and
      // has to trust class names, which is how a `text-xs uppercase
      // tracking-widest` kicker once became this site's `typography.body`.
      textTransform: cs.textTransform, letterSpacing: cs.letterSpacing,
    };
  }

  // A section's FIRST <p> is very often not its body copy: on a site that puts
  // an eyebrow/kicker above each heading ("AI-First Technology Company"), the
  // first paragraph is a label, and picking it makes every generated paragraph
  // sitewide render as a tiny uppercase label. Judged on computed style, not
  // class names, so it holds for any framework.
  function isLabelLike(el) {
    if (!el) return true;
    const cs = window.getComputedStyle(el);
    if (cs.textTransform === 'uppercase') return true;
    if (parseFloat(cs.fontSize) < 14) return true;
    // Wide tracking is a label convention; body copy is at or near normal.
    const ls = parseFloat(cs.letterSpacing);
    if (!Number.isNaN(ls) && ls >= 1) return true;
    // A kicker is a few words. Real body copy is a sentence or more.
    return (el.textContent || '').trim().length < 40;
  }

  // The most representative body element in a block, not merely the first.
  // Falls back to the longest-text candidate, then the first, so a block whose
  // paragraphs are ALL label-like still yields something rather than nothing.
  function pickBody(el) {
    const candidates = [...el.querySelectorAll('p, li, dd')].slice(0, 12);
    if (!candidates.length) return null;
    const real = candidates.find((c) => !isLabelLike(c));
    if (real) return real;
    return candidates.reduce((best, c) => (
      (c.textContent || '').trim().length > (best.textContent || '').trim().length ? c : best
    ), candidates[0]);
  }

  // Same first-match trap as pickBody: a block's first <a> is usually its CTA
  // button, so taking it made `typography.link` a button class list, which then
  // got merged onto every generated inline link. Prefer a plain inline link.
  function pickLink(el) {
    const candidates = [...el.querySelectorAll('a')].slice(0, 12);
    if (!candidates.length) return null;
    const plain = candidates.find((a) => {
      const cs = window.getComputedStyle(a);
      const buttonish = cs.display !== 'inline'
        && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      const named = /\b(btn|button)\b/i.test(typeof a.className === 'string' ? a.className : '');
      return !buttonish && !named;
    });
    return plain || candidates[0];
  }

  function fontPx(el) {
    return parseFloat(window.getComputedStyle(el).fontSize) || 0;
  }

  // A block's heading is its VISUALLY DOMINANT heading, not its first one in
  // DOM order. Some sites mark the eyebrow above a section title as a real
  // low-level heading (an <h4>/<h6>, often for a11y outline reasons), and that
  // eyebrow comes first — so first-match recorded the kicker's classes as this
  // site's heading convention and every generated <h2> inherited them.
  //
  // Deliberately NOT judged with isLabelLike: a heading may legitimately be
  // uppercase or wide-tracked (that is an ordinary display-type convention),
  // so the label test that is correct for body copy would reject real headings
  // here. Rendered size is the framework-agnostic signal that actually
  // separates a kicker from the title it sits above.
  function pickHeading(el) {
    const candidates = [...el.querySelectorAll('h1, h2, h3, h4')].slice(0, 12);
    if (!candidates.length) return null;
    // reduce keeps the FIRST of equal-sized candidates, so DOM order still
    // breaks ties between two headings of genuinely equal weight.
    return candidates.reduce((best, c) => (fontPx(c) > fontPx(best) ? c : best), candidates[0]);
  }

  // The inverse of pickLink, and the reason it has to exist: `cta` fed
  // components.button.primary, which projectCta stamps onto every generated
  // call-to-action sitewide. Taking the block's first <a>/<button> meant a
  // breadcrumb, a logo anchor, a "read more" text link or a nav toggle could
  // become the site's button convention.
  //
  // Returns null when the block has no genuinely button-like element, instead
  // of falling back to the first candidate. That is the point: no button
  // convention recorded means projectCta returns null and the caller keeps its
  // own plain markdown link, which is recoverable. A wrong one means every CTA
  // this platform ever writes for the site renders as something that is not a
  // button, which is not.
  function isChromeControl(el) {
    // Menu toggles, search and close buttons are button-shaped by definition
    // and carry no CTA styling worth copying.
    if (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls')) return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    return /\b(toggle|hamburger|menu|close|search|dismiss|carousel|slider|tab)\b/i.test(cls);
  }

  function pickCta(el) {
    const candidates = [...el.querySelectorAll('a, button')].slice(0, 16);
    return candidates.find((c) => {
      if (isChromeControl(c)) return false;
      // A real CTA is labelled. Icon-only controls have no text to speak of,
      // and their padding/sizing is wrong for a text button anyway.
      const text = (c.textContent || '').trim();
      if (text.length < 2 || text.length > 60) return false;
      const named = /\b(btn|button|cta)\b/i.test(typeof c.className === 'string' ? c.className : '');
      if (named) return true;
      // Otherwise it has to LOOK like a button: laid out as a box (not inline
      // running text) and visually bounded by a fill, a border, or a radius.
      const cs = window.getComputedStyle(c);
      if (cs.display === 'inline') return false;
      const filled = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
      return filled || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderRadius) > 0;
    }) || null;
  }

  function classesOf(el) {
    return (el && el.className && typeof el.className === 'string') ? el.className.trim().slice(0, 300) : '';
  }

  function unwrap(el) {
    // <header>/<nav>/<main>/<footer> are landmarks, not visual blocks — the
    // block boundaries that matter are their own direct children.
    if (['HEADER', 'NAV', 'MAIN', 'FOOTER'].includes(el.tagName) && el.children.length) {
      return [...el.children];
    }
    return [el];
  }

  const topLevel = [...document.body.children].flatMap(unwrap);
  const blocks = [];
  let order = 0;
  for (const el of topLevel) {
    const rect = el.getBoundingClientRect();
    if (rect.height < 4) continue; // invisible/collapsed — not a real block
    const heading = pickHeading(el);
    const body = pickBody(el);
    const cta = pickCta(el);
    const accordion = el.querySelector('details, [class*="accordion" i]');
    const accordionTrigger = accordion?.querySelector('summary, button, [class*="trigger" i]') || null;
    const accordionPanel = accordion?.querySelector('[class*="panel" i], [class*="content" i]') || null;
    const card = el.querySelector('[class*="card" i]');
    const cardInner = card?.querySelector(':scope > *') || null;
    const list = el.querySelector('ul, ol');
    const listItem = list?.querySelector('li') || null;
    const cs = window.getComputedStyle(el);
    blocks.push({
      order: order++,
      tag: el.tagName.toLowerCase(),
      landmark: el.closest('header') ? 'header' : el.closest('nav') ? 'nav' : el.closest('footer') ? 'footer' : null,
      classes: classesOf(el),
      top: Math.round(rect.top + window.scrollY),
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      viewportWidth: window.innerWidth,
      backgroundColor: cs.backgroundColor,
      padding: cs.padding,
      headingLevel: heading ? Number(heading.tagName[1]) : null,
      headingText: heading ? heading.textContent.trim().slice(0, 200) : null,
      headingStyle: styleOf(heading),
      headingClasses: classesOf(heading),
      bodyText: body ? body.textContent.trim().slice(0, 300) : null,
      bodyStyle: styleOf(body),
      bodyClasses: classesOf(body),
      ctaText: cta ? cta.textContent.trim().slice(0, 60) : null,
      ctaTag: cta ? cta.tagName.toLowerCase() : null,
      ctaClasses: classesOf(cta),
      imageCount: el.querySelectorAll('img, picture, svg').length,
      hasBackgroundImage: cs.backgroundImage !== 'none',
      accordionLike: !!accordion,
      accordionClasses: {
        wrapper: classesOf(accordion), item: classesOf(accordion), trigger: classesOf(accordionTrigger), panel: classesOf(accordionPanel),
      },
      cardLike: !!card,
      cardClasses: { wrapper: classesOf(card), body: classesOf(cardInner) },
      listClasses: { wrapper: classesOf(list), item: classesOf(listItem) },
      linkClasses: classesOf(pickLink(el)),
    });
  }
  return { title: document.title, blocks };
}
/* eslint-enable no-undef */

// screenshot: false by default — the Design Agent's own profile-derivation
// caller never needs it (structured DOM/CSS facts only), and a screenshot on
// every page load is real added cost. visual-quality.js (server/agents/
// visual-quality.js) is the one caller that opts in; the base64 JPEG it gets
// back is never written to disk or the DB anywhere in this codebase — kept
// in memory only, for the one LLM call it feeds, then discarded.
export async function capturePage(browserPage, url, { screenshot = false } = {}) {
  await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const { title, blocks } = await browserPage.evaluate(extractBlocksInPage);
  const result = { url, title, blocks };
  if (screenshot) {
    const buf = await browserPage.screenshot({ type: 'jpeg', quality: 70 });
    result.screenshot = buf.toString('base64');
  }
  return result;
}

// Orchestrates the whole site capture for one job: discover a page-type
// diverse set of URLs, then capture each. Returns raw (unsegmented)
// per-page block data — segment.js turns this into the schema's `sections`.
export async function captureSite(homepageUrl, {
  maxPages = DEFAULT_MAX_PAGES,
  launchBrowserFn = launchBrowser,
  screenshots = false,
} = {}) {
  const browser = await launchBrowserFn();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const targets = await discoverPages(page, homepageUrl, { maxPages });

    const pages = [];
    for (const { url, pageType } of targets) {
      // eslint-disable-next-line no-await-in-loop
      const captured = await capturePage(page, url, { screenshot: screenshots }).catch((err) => {
        console.warn(`[design-agent/capture] could not capture ${url}: ${err.message}`);
        return null;
      });
      if (captured) pages.push({ ...captured, pageType });
    }
    return { homepageUrl, pages };
  } finally {
    await browser.close();
  }
}
