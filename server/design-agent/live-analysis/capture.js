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
    };
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
    const heading = el.querySelector('h1, h2, h3, h4');
    const body = el.querySelector('p, li, dd');
    const cta = el.querySelector('a, button');
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
      linkClasses: classesOf(el.querySelector('a')),
    });
  }
  return { title: document.title, blocks };
}
/* eslint-enable no-undef */

export async function capturePage(browserPage, url) {
  await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const { title, blocks } = await browserPage.evaluate(extractBlocksInPage);
  return { url, title, blocks };
}

// Orchestrates the whole site capture for one job: discover a page-type
// diverse set of URLs, then capture each. Returns raw (unsegmented)
// per-page block data — segment.js turns this into the schema's `sections`.
export async function captureSite(homepageUrl, {
  maxPages = DEFAULT_MAX_PAGES,
  launchBrowserFn = launchBrowser,
} = {}) {
  const browser = await launchBrowserFn();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const targets = await discoverPages(page, homepageUrl, { maxPages });

    const pages = [];
    for (const { url, pageType } of targets) {
      // eslint-disable-next-line no-await-in-loop
      const captured = await capturePage(page, url).catch((err) => {
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
