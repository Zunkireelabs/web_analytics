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

// The viewports this agent actually looks at. `desktop` is the one the design
// PROFILE is derived from — it stays first and stays 1440x900 so every
// existing block/section/typography fact keeps the exact meaning it had when
// it was the only viewport that existed. `tablet` and `mobile` are measured
// separately and only ever ADD responsive facts; nothing about the profile's
// existing shape is derived from them.
//
// Sizes are real device classes, not round numbers: 834x1112 is iPad Air
// portrait, 390x844 is iPhone 12/13/14. Picked because a site's breakpoints
// are authored against real devices, so measuring between them (e.g. 800px)
// would report layout no real visitor sees.
export const DESKTOP_VIEWPORT = Object.freeze({ name: 'desktop', width: 1440, height: 900 });
export const RESPONSIVE_VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'tablet', width: 834, height: 1112 }),
  Object.freeze({ name: 'mobile', width: 390, height: 844 }),
]);

// Responsive probing costs one extra page load per page per extra viewport, so
// it is bounded independently of the profile capture. The probe itself is much
// cheaper than a profile capture (one evaluate() of measurements, no LLM, no
// markup serialization), which is why the default covers the whole captured
// set rather than a sample: a responsive defect on page 7 is exactly as real
// as one on page 1, and sampling would make detection depend on crawl order.
// Set DESIGN_AGENT_RESPONSIVE_MAX_PAGES=0 to skip responsive probing entirely.
const DEFAULT_RESPONSIVE_MAX_PAGES = process.env.DESIGN_AGENT_RESPONSIVE_MAX_PAGES === undefined
  ? DEFAULT_MAX_PAGES + 2
  : Number(process.env.DESIGN_AGENT_RESPONSIVE_MAX_PAGES);

// WCAG 2.2 SC 2.5.8 (Target Size, Minimum) — 24x24 CSS px. Deliberately the
// AA floor and not Apple's 44pt or Android's 48dp guidance: those are design
// recommendations, and flagging every control under 44px would bury a real
// defect under dozens of judgement calls on sites that are not actually
// broken. 24px is the threshold with an objective standard behind it.
const MIN_TAP_TARGET_PX = 24;
// See discoverCardHeavyPages below for why these exist separately from
// DEFAULT_MAX_PAGES.
const DEFAULT_EXTRA_CARD_PAGES = Number(process.env.DESIGN_AGENT_CAPTURE_EXTRA_CARD_PAGES) || 2;
const DEFAULT_CARD_SCAN_BUDGET = Number(process.env.DESIGN_AGENT_CAPTURE_CARD_SCAN_BUDGET) || 6;

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

// [listing page type, the detail page type reached FROM it] — see the
// second-hop block inside discoverPages for why this exists. Kept as a
// table rather than hardcoding "blog" so a future listing/detail pair
// (schema.js's PAGE_TYPES) is a one-line addition here.
const DEEPER_SAMPLE_TYPES = Object.freeze([
  ['blog-listing', 'blog-article'],
]);

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

  // ONE LEVEL DEEPER FOR THE PAGE TYPES INSERTED CONTENT ACTUALLY LANDS ON.
  //
  // Everything above is reachable from the HOMEPAGE's own links, and a site
  // typically links to its blog LISTING (/blog/) from the nav, never to an
  // individual post. So 'blog-article' — the single most common target for
  // inserted FAQ/Q&A/expand-content — routinely ended up with no captured
  // representative at all, and therefore no entry in the derived profile's
  // pageTypePatterns.
  //
  // That absence is not cosmetic: marker-merge.js's groundedInlineHeadingClass
  // asks pageTypePatterns[pageType] for this page type's real SUBHEADING
  // class, and with nothing recorded it falls back to the site's
  // section/page-title heading class — so every block spliced into a blog
  // post rendered at hero scale. Confirmed live on site 1 (zunkireelabs):
  // pageTypePatterns held 'blog-listing' but never 'blog-article'.
  //
  // Bounded deliberately: at most one extra navigation per missing inline
  // type, only when a listing page for it was already discovered above, and
  // only up to maxPages overall — this stays a targeted second hop, not a
  // crawl. A listing page that yields no usable article link simply leaves
  // that type unrepresented, exactly as before.
  for (const [listingType, articleType] of DEEPER_SAMPLE_TYPES) {
    if (byType.size >= maxPages) break;
    if (byType.has(articleType) || !byType.has(listingType)) continue;
    const listingUrl = byType.get(listingType);
    let listingLinks;
    try {
      await browserPage.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      listingLinks = await browserPage.evaluate(collectLinksInPage);
    } catch {
      continue; // an unreachable listing page tells us nothing — leave the type unrepresented
    }
    for (const href of listingLinks) {
      let abs;
      try { abs = new URL(href, listingUrl).href.split('#')[0]; } catch { continue; }
      if (!sameOrigin(abs, homepageUrl) || seen.has(abs)) continue;
      if (/\.(pdf|jpg|jpeg|png|svg|gif|zip|css|js|xml)$/i.test(abs)) continue;
      seen.add(abs);
      if (classifyPageType(abs) !== articleType) continue;
      byType.set(articleType, abs);
      break;
    }
  }

  return [...byType.entries()].map(([pageType, url]) => ({ url, pageType }));
}

// classifyPageType is a URL-shape heuristic (schema.js) — every page whose
// path doesn't match a known pattern (service/location/faq/blog/legal/...)
// falls into the same 'other' bucket, and discoverPages keeps only the FIRST
// url it meets for that whole bucket. A card-grid portfolio/case-study page
// (e.g. /projects/) is exactly as likely to be URL-classified 'other' as any
// unrelated miscellaneous page, so it can lose that one slot to something
// else entirely and never get captured — "flat" content-injection on such a
// page (design-profile.js's pageUsesCardSections/projectExpandContentCard
// has nothing to key off) traces back to this targeting gap, not a rendering
// bug. Whether a page is card-heavy is a STRUCTURAL fact invisible from its
// URL, so it can only be found by loading candidates and looking — this scans
// a bounded number of not-yet-captured same-origin links (re-collected from a
// fresh homepage visit, since discoverPages doesn't expose its own link list)
// and keeps the ones that turn out to have several repeating card-shaped
// blocks. Bounded on both axes (scanBudget page loads attempted, maxFound
// pages kept) so a large site can't turn this into an unbounded crawl.
export async function discoverCardHeavyPages(browserPage, homepageUrl, excludeUrls, {
  scanBudget = DEFAULT_CARD_SCAN_BUDGET,
  maxFound = DEFAULT_EXTRA_CARD_PAGES,
} = {}) {
  await browserPage.goto(homepageUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const rawLinks = await browserPage.evaluate(collectLinksInPage);

  const seen = new Set(excludeUrls);
  const found = [];
  let scanned = 0;
  for (const href of rawLinks) {
    if (found.length >= maxFound || scanned >= scanBudget) break;
    let abs;
    try { abs = new URL(href, homepageUrl).href.split('#')[0]; } catch { continue; }
    if (!sameOrigin(abs, homepageUrl) || seen.has(abs)) continue;
    if (/\.(pdf|jpg|jpeg|png|svg|gif|zip|css|js|xml)$/i.test(abs)) continue;
    seen.add(abs);
    scanned++;
    // eslint-disable-next-line no-await-in-loop
    const captured = await capturePage(browserPage, abs).catch((err) => {
      console.warn(`[design-agent/capture] could not scan ${abs} for card sections: ${err.message}`);
      return null;
    });
    if (!captured) continue;
    const cardBlockCount = captured.blocks.filter((b) => b.cardLike).length;
    // Two or more, same threshold design-profile.js's pageUsesCardSections
    // applies to the segmented sections this raw block count becomes — one
    // incidental card (a testimonial, a pricing callout) doesn't make a page
    // "card-heavy" the way a portfolio/case-study grid is.
    if (cardBlockCount >= 2) found.push({ ...captured, pageType: classifyPageType(abs) });
  }
  return found;
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

  // Full, untruncated outerHTML — unlike classesOf's 300-char class-string
  // summary, this has to stay byte-for-byte complete: it becomes the exact
  // anchor consistency-check.js's table/typography findings are matched and
  // patched against (see content-integrity-repair.js's 'table-style-drift'/
  // 'typography-drift' fixTypes), the same exact-anchor discipline
  // font-consistency-capture.js already established for its own outerHtml
  // field. A live DOM capture, not a second static fetch, on purpose: a
  // static re-fetch can miss classes a client-side hydration step added or
  // removed after load, which would make the "anchor" this repair patches
  // not the actual live markup a visitor sees.
  function outerHtmlOf(el) {
    return (el && typeof el.outerHTML === 'string') ? el.outerHTML : '';
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
    // A real <table> already on the tenant's own site — the one component
    // capture.js never looked for before, which is why table repair had
    // nothing tenant-specific to imitate and fell back to bare, unstyled
    // markup (content-integrity-repair.js's old buildTableHtml). headerCell
    // is read from <thead> when present, falling back to the first row's own
    // cells (many real sites style their first row as the header without a
    // literal <thead>). bodyRow prefers a <tbody> row over the header row so
    // the two slots don't collapse into the same class string on a table
    // whose header and body rows are actually styled differently.
    const table = el.querySelector('table');
    const tableHeaderCell = table?.querySelector('thead th, thead td, tr:first-child th, tr:first-child td') || null;
    const tableBodyRow = table?.querySelector('tbody tr, tr:nth-child(2)') || null;
    const tableBodyCell = tableBodyRow?.querySelector('td, th') || null;
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
      headingOuterHtml: outerHtmlOf(heading),
      bodyText: body ? body.textContent.trim().slice(0, 300) : null,
      bodyStyle: styleOf(body),
      bodyClasses: classesOf(body),
      bodyOuterHtml: outerHtmlOf(body),
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
      tableLike: !!table,
      tableClasses: {
        wrapper: classesOf(table), headerCell: classesOf(tableHeaderCell),
        row: classesOf(tableBodyRow), cell: classesOf(tableBodyCell),
      },
      tableOuterHtml: outerHtmlOf(table),
      linkClasses: classesOf(pickLink(el)),
    });
  }
  return { title: document.title, blocks };
}
/* eslint-enable no-undef */

// Runs in-page: MEASURES what this viewport actually renders, rather than
// reading class strings and inferring. This is the whole point of the
// responsive pass — `responsive.breakpoints` in the stored profile has only
// ever been a list of class PREFIXES the model reported seeing ("sm:",
// "md:"), which says a site is capable of responding to width, not that it
// does so correctly on any given page. Everything here is a number or a
// boolean read off the rendered page at a real device width.
//
// Deliberately much cheaper than extractBlocksInPage: no outerHTML
// serialization except for the handful of elements that are actually
// defective (which is the evidence a fix would need to anchor against), and
// every scan is bounded so a large DOM cannot turn one probe into a crawl.
// Exported (not just used internally by captureResponsive below) so a
// caller that has already navigated/mutated a page a different way — a
// pre-ship preview of a draft's content spliced into the live page, e.g.
// (see server/generators/lib/responsive-gate.js) — can run this exact same
// measurement via page.evaluate(measureResponsiveInPage, minTapTargetPx)
// without a second, redundant navigation.
/* eslint-disable no-undef */
export function measureResponsiveInPage(minTapTargetPx) {
  const vw = window.innerWidth;

  function isVisible(el) {
    if (!el || !el.getClientRects().length) return false;
    const cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  }

  function classesOf(el) {
    return (el && typeof el.className === 'string') ? el.className.trim().slice(0, 300) : '';
  }

  function describe(el, extra = {}) {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      classes: classesOf(el),
      text: (el.textContent || '').trim().slice(0, 80),
      width: Math.round(r.width),
      height: Math.round(r.height),
      // The exact live anchor a class-swap fix would patch against, same
      // discipline as extractBlocksInPage's outerHtml fields. Bounded: a
      // whole overflowing <section> can be enormous, and no fix needs more
      // than the opening element to match on.
      outerHtml: typeof el.outerHTML === 'string' ? el.outerHTML.slice(0, 4000) : '',
      ...extra,
    };
  }

  // ── Horizontal overflow ────────────────────────────────────────────────
  // The single most common real responsive defect: something wider than the
  // screen forces the whole page to pan sideways. Reported as the OUTERMOST
  // offending elements — descending into an overflowing container would list
  // every one of its children too and bury the actual cause.
  const docScrollWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0,
  );
  const overflowPx = Math.max(0, Math.round(docScrollWidth - vw));

  const overflowingElements = [];
  if (overflowPx > 1 && document.body) {
    const queue = [...document.body.children];
    let scanned = 0;
    while (queue.length && overflowingElements.length < 5 && scanned < 800) {
      const el = queue.shift();
      scanned++;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const right = r.right;
      if (right > vw + 1 || r.width > vw + 1) {
        overflowingElements.push(describe(el, { overflowBy: Math.round(Math.max(right - vw, r.width - vw)) }));
        continue; // outermost only — do not descend into a known offender
      }
      for (const child of el.children) queue.push(child);
    }
  }

  // ── Stacking ───────────────────────────────────────────────────────────
  // Measured, not inferred from grid/flex declarations: group each block's
  // direct children by their rendered top edge and count how many share a
  // row. A block laid out as one column at this width has columns === 1,
  // whatever CSS mechanism produced it. That makes this framework-agnostic
  // (CSS grid, flexbox, floats, or a table all read the same).
  function columnsOf(el) {
    const kids = [...el.children].filter(isVisible);
    if (kids.length < 2) return kids.length;
    const rows = new Map();
    for (const kid of kids.slice(0, 24)) {
      const top = Math.round(kid.getBoundingClientRect().top / 8) * 8; // 8px tolerance
      rows.set(top, (rows.get(top) || 0) + 1);
    }
    return Math.max(...rows.values());
  }

  function unwrapLandmark(el) {
    if (['HEADER', 'NAV', 'MAIN', 'FOOTER'].includes(el.tagName) && el.children.length) return [...el.children];
    return [el];
  }

  const blocks = [];
  const topLevel = document.body ? [...document.body.children].flatMap(unwrapLandmark) : [];
  let order = 0;
  for (const el of topLevel.slice(0, 40)) {
    const r = el.getBoundingClientRect();
    if (r.height < 4) { order++; continue; }
    const cs = window.getComputedStyle(el);
    blocks.push({
      order: order++,
      tag: el.tagName.toLowerCase(),
      classes: classesOf(el),
      width: Math.round(r.width),
      height: Math.round(r.height),
      columns: columnsOf(el),
      paddingTop: Math.round(parseFloat(cs.paddingTop) || 0),
      paddingLeft: Math.round(parseFloat(cs.paddingLeft) || 0),
      outerHtml: typeof el.outerHTML === 'string' ? el.outerHTML.slice(0, 1500) : '',
    });
  }

  // ── Navigation ─────────────────────────────────────────────────────────
  // Does the nav collapse behind a control at this width? Both halves are
  // measured: how many nav links are actually visible, and whether a visible
  // disclosure control exists. A nav that keeps 8 visible links at 390px has
  // not collapsed, whatever its classes claim.
  const navRoot = document.querySelector('header nav') || document.querySelector('nav') || document.querySelector('header');
  let navigation = null;
  if (navRoot) {
    const links = [...navRoot.querySelectorAll('a')];
    const controls = [...navRoot.querySelectorAll('button, [role="button"], [aria-expanded], [aria-controls]')];
    navigation = {
      visibleLinks: links.filter(isVisible).length,
      totalLinks: links.length,
      hasVisibleToggle: controls.some((c) => isVisible(c)
        && (c.hasAttribute('aria-expanded') || c.hasAttribute('aria-controls')
          || /\b(toggle|hamburger|menu|nav)\b/i.test(classesOf(c)))),
    };
  }

  // ── Type scale & spacing ───────────────────────────────────────────────
  // The dominant heading and a real body paragraph at this width. Body copy
  // is filtered the same way pickBody does it (length, not class names) so a
  // kicker never becomes the measured body size.
  function measureText(el) {
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    return {
      fontSize: Math.round(parseFloat(cs.fontSize) || 0),
      lineHeight: Math.round(parseFloat(cs.lineHeight) || 0),
    };
  }
  const headingEl = [...document.querySelectorAll('h1, h2')].filter(isVisible)
    .sort((a, b) => (parseFloat(window.getComputedStyle(b).fontSize) || 0) - (parseFloat(window.getComputedStyle(a).fontSize) || 0))[0] || null;
  const bodyEl = [...document.querySelectorAll('p')].find((p) => isVisible(p) && (p.textContent || '').trim().length >= 40) || null;

  // ── Tap targets (small viewports) ──────────────────────────────────────
  const smallTapTargets = [];
  const interactive = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"]')].slice(0, 400);
  for (const el of interactive) {
    if (smallTapTargets.length >= 5) break;
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    // Zero-size and icon-in-link wrappers are excluded by requiring a real
    // rendered box; a control with no box is not a tap target a user misses.
    if (r.width < 1 || r.height < 1) continue;
    if (r.width < minTapTargetPx || r.height < minTapTargetPx) {
      smallTapTargets.push(describe(el, { minSide: Math.round(Math.min(r.width, r.height)) }));
    }
  }

  // ── Clipped content ────────────────────────────────────────────────────
  // Text cut off rather than wrapped: the element's own content is wider than
  // its box AND it is set to hide the excess.
  const clippedElements = [];
  for (const el of topLevel.slice(0, 40)) {
    if (clippedElements.length >= 5) break;
    if (!isVisible(el)) continue;
    const cs = window.getComputedStyle(el);
    if (cs.overflowX !== 'hidden' && cs.overflow !== 'hidden') continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      clippedElements.push(describe(el, { clippedBy: Math.round(el.scrollWidth - el.clientWidth) }));
    }
  }

  return {
    viewportWidth: vw,
    documentScrollWidth: Math.round(docScrollWidth),
    overflowPx,
    overflowingElements,
    blocks,
    navigation,
    typography: { heading: measureText(headingEl), body: measureText(bodyEl) },
    smallTapTargets,
    clippedElements,
  };
}
/* eslint-enable no-undef */

// One responsive probe of one URL at whatever viewport `browserPage`'s context
// was created with. Separate from capturePage on purpose: this never
// serializes the full block/markup set, so probing two extra viewports costs
// roughly a page load each rather than a second full capture.
export async function captureResponsive(browserPage, url, { minTapTargetPx = MIN_TAP_TARGET_PX } = {}) {
  await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  return browserPage.evaluate(measureResponsiveInPage, minTapTargetPx);
}

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
  extraCardPages = DEFAULT_EXTRA_CARD_PAGES,
  responsiveViewports = RESPONSIVE_VIEWPORTS,
  responsiveMaxPages = DEFAULT_RESPONSIVE_MAX_PAGES,
} = {}) {
  const browser = await launchBrowserFn();
  try {
    const context = await browser.newContext({
      viewport: { width: DESKTOP_VIEWPORT.width, height: DESKTOP_VIEWPORT.height },
    });
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

    // See discoverCardHeavyPages: classifyPageType's URL-only bucketing can
    // lose a genuine card-grid page (e.g. /projects/) to whatever else won
    // its 'other' slot above. extraCardPages: 0 opts out entirely (tests,
    // and any caller that wants the old exact page set).
    if (extraCardPages > 0) {
      const cardPages = await discoverCardHeavyPages(page, homepageUrl, pages.map((p) => p.url), { maxFound: extraCardPages });
      for (const captured of cardPages) pages.push(captured);
    }

    // Responsive pass. One fresh context per extra viewport (a context's
    // viewport is fixed at creation, and re-using the desktop page with
    // setViewportSize would leave desktop-width layout state and media-query
    // listeners already resolved — a real source of false "it stacks fine"
    // readings). The desktop measurements come from the SAME probe so every
    // viewport is compared like-for-like rather than against block data
    // produced by a different code path.
    const responsive = { viewports: [], pages: [] };
    const probeTargets = pages.slice(0, Math.max(0, responsiveMaxPages));
    if (probeTargets.length && responsiveViewports.length) {
      const viewports = [DESKTOP_VIEWPORT, ...responsiveViewports];
      const byUrl = new Map(probeTargets.map((p) => [p.url, { url: p.url, pageType: p.pageType, byViewport: {} }]));

      for (const viewport of viewports) {
        // eslint-disable-next-line no-await-in-loop
        const vpContext = viewport.name === DESKTOP_VIEWPORT.name
          ? context
          : await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            // isMobile/hasTouch make a site's own mobile detection (and any
            // touch-only nav) behave the way it does for a real visitor.
            isMobile: viewport.width < 768,
            hasTouch: viewport.width < 768,
          });
        // eslint-disable-next-line no-await-in-loop
        const vpPage = viewport.name === DESKTOP_VIEWPORT.name ? page : await vpContext.newPage();
        try {
          for (const target of probeTargets) {
            // eslint-disable-next-line no-await-in-loop
            const measured = await captureResponsive(vpPage, target.url).catch((err) => {
              console.warn(`[design-agent/capture] could not measure ${target.url} at ${viewport.name}: ${err.message}`);
              return null;
            });
            if (measured) byUrl.get(target.url).byViewport[viewport.name] = measured;
          }
          responsive.viewports.push({ ...viewport });
        } finally {
          if (viewport.name !== DESKTOP_VIEWPORT.name) await vpContext.close();
        }
      }
      // A page every viewport failed to measure carries no responsive signal
      // at all — keeping it would make "no defects found" indistinguishable
      // from "never looked".
      responsive.pages = [...byUrl.values()].filter((p) => Object.keys(p.byViewport).length > 0);
    }

    return { homepageUrl, pages, responsive };
  } finally {
    await browser.close();
  }
}
