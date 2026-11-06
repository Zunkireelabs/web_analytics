// Four technical checks this codebase did not have, verified as genuinely missing by mapping every issue type a
// general-purpose SEO crawler reports against what our own agents already cover:
//
//   redirect-loop               agents/redirect-chain.js follows chains but treats a loop as just a long chain
//   heading-order-skip          page-content.js captures the heading outline but never checks its order
//   no-outgoing-links           internal links are counted, never checked for zero
//   duplicate-meta-description  technical-seo.js checks duplicate TITLES only
//
// Everything else in that list was already covered (canonical conflict, deep pages, multiple H1, missing title, slow
// response, JS-rendering suspicion, noindex, orphan pages, thin and duplicate content, redirect chains), so only
// these four are here. Each is pure and takes data the existing crawl already collects — no new fetch, no new cost.

// ---------------------------------------------------------------------------
// 1. Redirect loop
// ---------------------------------------------------------------------------

/**
 * A redirect LOOP is different from a long chain: a chain eventually arrives somewhere, a loop never does, so the page
 * is permanently unreachable for a crawler and a visitor. Reported separately because the fix is different too —
 * lengthening the hop limit will not help.
 *
 * `hops` is the sequence of URLs a redirect follow produced, in order, as redirect-chain.js already collects.
 * Returns { loop: true, repeatedUrl, cycle } or { loop: false }.
 */
export function detectRedirectLoop(hops) {
  const seen = new Map();
  const normalized = (hops || []).map(normalizeUrl).filter(Boolean);
  for (let i = 0; i < normalized.length; i += 1) {
    const url = normalized[i];
    if (seen.has(url)) {
      return {
        loop: true,
        repeatedUrl: url,
        // The cycle itself, from the first visit to the repeat — what a person needs to see to fix it.
        cycle: normalized.slice(seen.get(url), i + 1),
      };
    }
    seen.set(url, i);
  }
  return { loop: false };
}

// Compared without the trailing slash and without the scheme, because http://x/a -> https://x/a/ -> http://x/a is a
// real loop that a literal string comparison would miss.
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '') || null;
  }
}

// ---------------------------------------------------------------------------
// 2. Heading order
// ---------------------------------------------------------------------------

/**
 * A heading level skipped on the way down (H1 straight to H3) breaks the document outline that screen readers and
 * search engines use to understand a page's structure. Going back UP is normal and not a defect: H3 then H2 simply
 * starts a new section.
 *
 * `outline` is [{ level, text }] or [{ tag: 'h2', text }], as page-content.js's headingOutline already provides.
 * Returns { skips: [{ from, to, text }] } — empty when the outline is sound.
 */
export function detectHeadingOrderSkips(outline) {
  const levels = (outline || [])
    .map((h) => ({ level: levelOf(h), text: String(h?.text || '').trim().slice(0, 120) }))
    .filter((h) => h.level);
  const skips = [];
  let previous = null;
  for (const heading of levels) {
    // Only a DESCENT of more than one level is a skip. The first heading is compared against nothing: a page whose
    // outline starts at H2 is a different issue (missing H1), already covered elsewhere.
    if (previous != null && heading.level > previous + 1) {
      skips.push({ from: `h${previous}`, to: `h${heading.level}`, text: heading.text });
    }
    previous = heading.level;
  }
  return { skips };
}

function levelOf(heading) {
  if (!heading) return null;
  if (Number.isInteger(heading.level) && heading.level >= 1 && heading.level <= 6) return heading.level;
  const tag = String(heading.tag || heading.name || '').toLowerCase();
  const m = /^h([1-6])$/.exec(tag);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// 3. No outgoing internal links
// ---------------------------------------------------------------------------

/**
 * A page with no internal links out is a dead end: a crawler reaching it finds nowhere to go, and whatever authority
 * it has flows nowhere. Distinct from an orphan page, which is the opposite problem (nothing links IN).
 *
 * Links to the page's own URL and pure fragment links do not count as going anywhere.
 */
export function detectNoOutgoingLinks(pageUrl, internalLinks, { ignorePaths = [] } = {}) {
  const self = normalizeUrl(pageUrl);
  const outgoing = (internalLinks || [])
    .map((l) => (typeof l === 'string' ? l : l?.href || l?.url))
    .filter((href) => href && !String(href).trim().startsWith('#'))
    .map(normalizeUrl)
    .filter((href) => href && href !== self)
    .filter((href) => !ignorePaths.some((p) => href.endsWith(normalizeUrl(p) || '\u0000')));
  const unique = [...new Set(outgoing)];
  return { outgoingCount: unique.length, deadEnd: unique.length === 0 };
}

// ---------------------------------------------------------------------------
// 4. Duplicate meta descriptions
// ---------------------------------------------------------------------------

/**
 * Two pages sharing a meta description compete for the same snippet and tell a search engine they are the same thing.
 * The site already checks duplicate TITLES this way; this is the same check for descriptions.
 *
 * `pages` is [{ url, metaDescription }]. Pages with no description are NOT reported here — that is
 * 'missing-meta-description', a different issue that is already covered.
 *
 * Grouped case-insensitively and whitespace-normalised, because two descriptions differing only in spacing are the
 * same snippet to a search engine.
 */
export function detectDuplicateMetaDescriptions(pages, { minLength = 20 } = {}) {
  const byDescription = new Map();
  for (const page of pages || []) {
    const url = page?.url;
    const text = String(page?.metaDescription ?? page?.meta_description ?? '').trim();
    if (!url || text.length < minLength) continue;
    const key = text.toLowerCase().replace(/\s+/g, ' ');
    if (!byDescription.has(key)) byDescription.set(key, { description: text, urls: [] });
    const entry = byDescription.get(key);
    if (!entry.urls.includes(url)) entry.urls.push(url);
  }
  const duplicates = [...byDescription.values()]
    .filter((e) => e.urls.length > 1)
    .sort((a, b) => b.urls.length - a.urls.length)
    .map((e) => ({ description: e.description.slice(0, 160), urls: e.urls, count: e.urls.length }));
  return { duplicates };
}
