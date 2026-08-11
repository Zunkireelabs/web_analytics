import * as cheerio from 'cheerio';
import { describeFetchFailure, describeHttpFailure } from '../../lib/errors.js';

// Live-fetches a landing page and checks what's actually on it, so the
// Opportunity Agent's recommendations are grounded in the real page instead
// of guessed from ranking signals alone. One fetch per unique page URL per
// agent run (callers should cache across queries that share a landing page).

const FETCH_TIMEOUT_MS = 5000;
const MIN_META_DESCRIPTION_LEN = 50;
const MAX_META_DESCRIPTION_LEN = 160;
const MIN_INTERNAL_LINKS = 3;
const MIN_WORD_COUNT = 300;
// Rock-bottom sanity floor for grounding an LLM call in real page content —
// deliberately much lower than MIN_WORD_COUNT (that one's an SEO "this page
// needs more content" heuristic for a genuinely published page; this one
// just answers "did extraction actually find real content at all," so a
// generator can refuse to run rather than draft schema/FAQ/copy off of
// whatever nav/footer text is all that's left after boilerplate stripping —
// see extractMainText/requireGroundedContent below).
export const MIN_GROUNDING_WORDS = 40;
// Real content containers, checked in priority order against the ALREADY
// boilerplate-stripped document (see extractMainText) — common semantic tag
// first, then common CMS/theme content-div conventions. First match with
// enough real text wins; a match with almost no text (e.g. an empty <main>
// wrapper around a client-rendered app) is treated as no match at all so it
// doesn't preempt a better-populated fallback.
const MAIN_CONTENT_SELECTORS = ['main', 'article', '[role="main"]', '#content', '.content', '#main-content', '.main-content', '.post-content', '.entry-content', '.article-body', '.article-content'];
// Removed from a CLONE of the loaded document before any text extraction —
// nav/header/footer/script/style/etc. must never contribute to the text an
// LLM generator grounds itself in, whether or not a MAIN_CONTENT_SELECTORS
// match is found. Applied even on the whole-body fallback path, so "no
// dedicated content container found" still never means "raw, unstripped
// document.body" — only ever "stripped body, best effort."
const BOILERPLATE_SELECTORS = 'nav, header, footer, script, style, noscript, aside, form, ' +
  '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
  '.nav, .navbar, .menu, .site-header, .site-footer, .cookie-banner, .cookie-consent';
// Standard SERP-snippet-width-derived range — below this a title is usually
// thin/generic, above it Google truncates the displayed title in results.
const MIN_TITLE_LEN = 30;
const MAX_TITLE_LEN = 60;
// Meaningfully large, not incidental — a handful of one-off inline styles is
// normal; this flags pages where inline style="" has effectively replaced
// shared CSS, same "several, not one-off" bar as hasFaqAccordion's >=2.
export const MAX_INLINE_STYLE_COUNT = 20;
// ~100KB matches the common "keep HTML lean" guidance behind Lighthouse/PSI's
// own large-payload audits — well past this, HTML parse/transfer time starts
// to matter. Measured off the fetched (already-decompressed) HTML string
// via Buffer.byteLength, so it reflects real transfer-relevant size even
// with multi-byte characters, not raw wire bytes (fetch already decodes
// Content-Encoding before this module ever sees the string).
export const MAX_HTML_SIZE_BYTES = 100 * 1024;
// Common short function/structure words that appear in nearly every title
// regardless of topic — excluded so keyword-consistency only compares the
// title's real topical terms against the body, not incidental glue words.
const TITLE_STOPWORDS = new Set(['a', 'an', 'and', 'the', 'of', 'in', 'on', 'for', 'to', 'with', 'at', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'or', 'as', 'that', 'this', 'your', 'you', 'our', 'we', '&']);

// String-level guard against fetching a private/local address — every page
// this module fetches ultimately comes from real, external data (a site's
// own GSC page URL, or an LLM-named competitor domain), but nothing
// previously stopped a same-host redirect from resolving somewhere like
// 169.254.169.254 (cloud metadata) or localhost. Not a full SSRF defense
// (doesn't catch DNS rebinding — the hostname string can look public while
// resolving to a private IP at connect time), but blocks the common,
// cheap case. Exported so the technical-seo redirect-chain follower
// (server/agents/lib/technical-seo-analysis.js) applies the same check to
// every hop, not just the first request.
const PRIVATE_HOSTNAME_PATTERNS = [/^localhost$/i, /\.local$/i, /\.internal$/i];
export function isPrivateOrLocalHost(hostname) {
  if (!hostname) return true;
  if (PRIVATE_HOSTNAME_PATTERNS.some((re) => re.test(hostname))) return true;
  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1, 3).map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const v6 = hostname.replace(/^\[|\]$/g, '');
  if (v6 === '::1' || /^fe80:/i.test(v6) || /^f[cd][0-9a-f]{2}:/i.test(v6)) return true;
  return false;
}

export async function fetchHtml(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return { ok: false, error: 'invalid URL' }; }
  if (isPrivateOrLocalHost(hostname)) return { ok: false, error: 'blocked: private/local address' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +opportunity-agent)' },
    });
    if (!res.ok) return { ok: false, error: describeHttpFailure(res.status) };
    // Harmless when every caller only ever passes a known page URL (from
    // GSC), but the site-wide crawler (site-discovery.js) follows arbitrary
    // discovered hrefs — some of which are PDFs/images/etc, not HTML —
    // and cheerio parsing binary content as HTML is a waste at best.
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('html')) return { ok: false, error: 'not HTML' };
    // `res.url` is the real final URL after `fetch`'s default redirect-follow
    // — lets a caller notice "this link redirected back to the page it was
    // linked from" (trust-compliance.js's dead cookie/privacy/terms link
    // check) without a second request.
    return { ok: true, html: await res.text(), url: res.url };
  } catch (err) {
    return { ok: false, error: describeFetchFailure('page-content.fetchHtml', err) };
  } finally {
    clearTimeout(timeout);
  }
}

// Extracts the real, LLM-groundable text of a page — a dedicated content
// container when one can be found (never nav/header/footer/script/style,
// which are stripped first), falling back to the rest of the stripped
// document only when no container matches. This is deliberately a SEPARATE
// cheerio.load() from the `$` used by the rest of analyzePage() below: every
// other signal in this file (internal links, images, forms, schema
// detection, accordion detection, ...) legitimately needs the WHOLE,
// unmodified document, so boilerplate-stripping must never touch that `$`.
function extractMainText(html) {
  const $clean = cheerio.load(html);
  $clean(BOILERPLATE_SELECTORS).remove();
  for (const selector of MAIN_CONTENT_SELECTORS) {
    const text = $clean(selector).first().text().replace(/\s+/g, ' ').trim();
    if (text.split(' ').filter(Boolean).length >= MIN_GROUNDING_WORDS) return { text, selector };
  }
  return { text: $clean('body').text().replace(/\s+/g, ' ').trim(), selector: null };
}

// Shared by every generator that grounds an LLM prompt in a live page's real
// content (schema.js, faq.js, qa-content.js, meta-title.js,
// expand-content.js) — a fetch can succeed (200, real HTML) while the real
// content extraction still comes up empty/thin (client-side-rendered
// content the static fetch never sees, or the page genuinely is just a nav
// shell), which must never silently ground an LLM call in whatever
// boilerplate is left. Pure predicate, no throw — see requireGroundedContent
// for the throwing variant mandatory-page generators use.
export function hasSufficientGroundingContent(analysis) {
  return !!analysis && (analysis.wordCount || 0) >= MIN_GROUNDING_WORDS;
}

// Throwing variant for generators that treat a page as mandatory (schema,
// qa-content, expand-content — all already throw on `!fetched.ok`, this is
// the same "refuse rather than draft on bad input" contract extended to
// "fetch succeeded but real content didn't"). Generators that treat page
// content as optional (faq, meta-title) should use
// hasSufficientGroundingContent instead and degrade to their existing
// no-page-content mode rather than hard-failing.
export function requireGroundedContent(analysis, { generatorId } = {}) {
  if (hasSufficientGroundingContent(analysis)) return;
  const words = analysis?.wordCount || 0;
  throw Object.assign(
    new Error(`Not enough real page content could be extracted to ground ${generatorId || 'this generator'} ` +
      `(found ${words} word(s) after stripping nav/header/footer/script/style — need ${MIN_GROUNDING_WORDS}+). ` +
      'The page may be thin, client-side-rendered, or nav/template-only — try again once it has real content.'),
    { status: 502, userFacing: true },
  );
}

export function analyzePage(html, pageUrl) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const metaDescription = ($('meta[name="description"]').attr('content') || '').trim();
  const headingText = $('h1, h2, h3').text();

  const schemaTypes = new Set();
  let hasFaqSchema = false;
  // GEO signals confirmed via a cross-check against the sibling audit tool's
  // geo checks (authorExpertise.js/freshnessSignals.js/reviewRatingSchema.js)
  // — same detection logic, so a page verified by that tool and this one
  // agree. Blocks (top-level JSON-LD items + their flattened @graph entries)
  // are collected once so each of author/date/review can inspect them
  // without three separate re-parses of the same script tags.
  let hasAuthorSchema = false;
  let hasFreshnessSchema = false;
  let hasReviewSchema = false;
  // Duplicate-schema and invalid-JSON-LD are real, technical issues a
  // generator now DOES auto-fix, exact-match-or-refuse only — see
  // generators/schema-repair.js + implementers/lib/schema-repair-inject.js.
  // schemaTypes itself is a Set (dedupes types by design, for every other
  // check in this file that just needs presence), so a separate per-type
  // occurrence count is needed to notice a real page shipping the same
  // @type twice.
  const schemaTypeCounts = new Map();
  let malformedJsonLdBlocks = 0;
  // Raw script inner text of each block that fails to parse — kept
  // alongside the count above (which existing callers already read) so a
  // repair generator (generators/schema-repair.js) has the real broken text
  // to both feed an LLM correction and later find verbatim in the site's
  // own source file to patch (implementers/lib/exact-match-patch.js) —
  // never a guess at what the block "probably" contained.
  const malformedSchemaBlocks = [];
  // One entry per real <script> tag (not per flattened block — @graph/array
  // shapes put several blocks in one script tag, but the removal unit for a
  // duplicate is the whole tag), so schema-repair.js's duplicate-removal fix
  // has the real raw text of each occurrence to anchor an exact-match patch
  // against, in document order.
  const schemaScriptBlocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      const blocks = [];
      for (const item of items) {
        if (item && typeof item === 'object') blocks.push(item);
        if (item && Array.isArray(item['@graph'])) {
          for (const g of item['@graph']) if (g && typeof g === 'object') blocks.push(g);
        }
      }
      const tagTypes = [];
      for (const block of blocks) {
        const types = [].concat(block['@type'] || []).flat();
        types.forEach((t) => { if (t) { schemaTypes.add(t); schemaTypeCounts.set(t, (schemaTypeCounts.get(t) || 0) + 1); tagTypes.push(t); } });
        if (types.includes('FAQPage')) hasFaqSchema = true;
        if (types.includes('Review') || types.includes('AggregateRating')) hasReviewSchema = true;
        const rating = block.aggregateRating;
        if (rating && typeof rating === 'object') {
          const ratingTypes = [].concat(rating['@type'] || []).flat();
          if (ratingTypes.includes('AggregateRating') || (rating.ratingValue && rating.reviewCount)) hasReviewSchema = true;
        }
        const author = block.author;
        if (typeof author === 'string' && author.trim()) hasAuthorSchema = true;
        else if (Array.isArray(author) && author.some((a) => a && (a.name || typeof a === 'string'))) hasAuthorSchema = true;
        else if (author && typeof author === 'object' && author.name) hasAuthorSchema = true;
        if (block.datePublished || block.dateModified) hasFreshnessSchema = true;
      }
      schemaScriptBlocks.push({ raw, types: tagTypes });
    } catch { malformedJsonLdBlocks++; malformedSchemaBlocks.push(raw); }
  });
  const duplicateSchemaTypes = [...schemaTypeCounts.entries()].filter(([, count]) => count > 1).map(([t]) => t);
  const hasAnySchema = schemaTypes.size > 0;
  // Heading text alone misses real FAQ sections that don't literally say "FAQ"
  // (e.g. a "Get to know Us" accordion) — so also check for FAQ-labeled markup
  // (id/class/aria-label, including framework refs like Alpine's x-ref) and,
  // failing that, the structural shape of an accordion: several clickable
  // question elements whose text ends in "?".
  const hasFaqMarkup = $('[id*="faq" i], [class*="faq" i], [aria-label*="faq" i], [aria-label*="frequently asked" i], [x-ref*="faq" i]').length > 0;
  const questionElements = $('button, summary, dt, [role="button"]').filter((_, el) => {
    const text = $(el).text().trim();
    return text.length > 0 && text.length < 200 && text.endsWith('?');
  });
  const hasFaqAccordion = questionElements.length >= 2;
  const hasFaqHeading = /faq|frequently asked questions/i.test(headingText) || hasFaqMarkup || hasFaqAccordion;

  // Byline/date markup outside JSON-LD — same non-schema fallback signals
  // the audit tool's authorExpertise.js/freshnessSignals.js check.
  const hasAuthorMarkup = $('[rel="author"]').length > 0
    || $('[itemprop="author"]').length > 0
    || $('meta[name="author"]').length > 0
    || $('.author, .byline, [class*="author-"]').length > 0;
  const hasFreshnessMeta = $('meta[property="article:published_time"]').length > 0
    || $('meta[property="article:modified_time"]').length > 0;
  const hasFreshnessTimeTag = $('time[datetime]').length > 0;

  let host = null;
  let isRootPage = false;
  try {
    const parsed = new URL(pageUrl);
    host = parsed.hostname;
    // Same segment check breadcrumbs.js itself refuses on (no real trail to
    // draft for the homepage) — computed here too so the gap never fires in
    // the first place, see contentGapChecks below.
    isRootPage = parsed.pathname.split('/').filter(Boolean).length === 0;
  } catch { /* leave host/isRootPage at defaults */ }
  // Every real internal href, resolved to an absolute URL — one entry per
  // matching anchor tag (not deduped; a page linking the same URL 5 times
  // still contributes 5 entries here, same as internalLinkCount always
  // counted before this change — dedup is the crawler's job, not this
  // function's). Used by the technical-seo agent's broken-link/redirect-
  // chain crawl (server/agents/lib/technical-seo-analysis.js). Always
  // resolves via `new URL(href, pageUrl)` and checks the real hostname,
  // rather than the previous shortcut of trusting any href starting with
  // '/' — that shortcut incorrectly counted protocol-relative external
  // links (e.g. "//evil.com/x", which also starts with '/') as internal.
  const internalLinks = [];
  const internalLinkCount = host
    ? $('a[href]').filter((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('#')) return false;
      let resolved;
      try { resolved = new URL(href, pageUrl); } catch { return false; }
      if (resolved.hostname !== host) return false;
      internalLinks.push(resolved.href);
      return true;
    }).length
    : 0;

  // Distinct external, non-self domains linked from the page's real content —
  // same signal and >=2 threshold as the audit tool's externalCitations.js.
  // Well-sourced content (citing outside authorities) is more likely to be
  // reused/cited by an AI assistant than a page that never links out.
  const externalCitationDomains = new Set();
  // Real hrefs (not just the domain set above) — technical-seo-analysis.js's
  // crawlExternalCitations liveness-checks these the same way
  // crawlInternalLinks already checks internalLinks, so a citation that's
  // gone dead since this page was written gets flagged/removed the same as
  // any other broken link, distinct only in its finding label.
  const externalCitationLinks = [];
  if (host) {
    $('article a[href], main a[href], body a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!/^https?:\/\//i.test(href)) return;
      try {
        const linkHost = new URL(href).hostname.replace(/^www\./, '');
        if (linkHost !== host.replace(/^www\./, '')) { externalCitationDomains.add(linkHost); externalCitationLinks.push(href); }
      } catch { /* ignore malformed href */ }
    });
  }

  const { text: bodyText, selector: mainContentSelector } = extractMainText(html);
  const wordCount = bodyText ? bodyText.split(' ').filter(Boolean).length : 0;

  const images = $('img');
  const imagesWithoutAlt = images.filter((_, el) => !($(el).attr('alt') || '').trim()).length;
  // Real grounding for alt-text.js — the filename alone is often enough to
  // draft an honest, generic caption ("Blue running shoes" from
  // "blue-running-shoes.jpg"), but nearby real page text (a figcaption, or
  // the closest preceding heading) is the actual fact the generator grounds
  // in when the filename is uninformative, same "ground in real text, never
  // guess unseen visual detail" rule every other generator already follows.
  // Capped — a page with hundreds of images doesn't need all of them in one
  // draft; alt-text.js can be re-run for the rest.
  const MAX_IMAGES_MISSING_ALT = 15;
  const imagesMissingAlt = images
    .filter((_, el) => !($(el).attr('alt') || '').trim())
    .slice(0, MAX_IMAGES_MISSING_ALT)
    .map((_, el) => {
      const $el = $(el);
      const src = ($el.attr('src') || $el.attr('data-src') || '').trim();
      const figcaption = $el.closest('figure').find('figcaption').first().text().trim();
      const nearbyHeading = $el.prevAll('h1, h2, h3, h4').first().text().trim()
        || $el.closest('section, article, div').find('h1, h2, h3, h4').first().text().trim();
      // Real outer markup of this exact tag — same "exact snippet anchor"
      // convention duplicate-id-fix.js's duplicateIds already uses (see
      // $.html(el).slice(0,160) there). implementers/lib/alt-text-inject.js
      // finds this EXACT string, byte-for-byte, in the site's real template
      // source before patching alt="" into it — never a guess against a
      // component-based site's rendered-vs-source mismatch.
      const originalTag = $.html(el) || '';
      return { src, nearbyText: figcaption || nearbyHeading || '', originalTag };
    })
    .get()
    // originalTag (not src) is the real anchor alt-text-inject.js patches
    // against — src is only a best-effort filename hint for the LLM prompt,
    // and alt-text.js already handles an empty one honestly ("no real clue"
    // branch). Filtering on src here silently dropped lazy-loaded/srcset-only
    // images that were still perfectly patchable, so imagesMissingAlt (what
    // alt-text.js actually drafts against) came back empty while the
    // imagesWithoutAlt count (what the finding is worded from) stayed >0 —
    // a finding that could never be drafted, same guaranteed-to-fail class
    // fixed for breadcrumbs/freshness-date/author-byline.
    .filter((img) => img.originalTag);

  const hasComparisonTable = $('table').filter((_, el) => /\bvs\.?\b|\bversus\b|\bcomparison\b/i.test($(el).text())).length > 0;
  const hasComparisonHeading = /\bvs\.?\b|\bversus\b|\bcompar(e|ison)\b/i.test(headingText);

  // Real resolved target, not just tag presence — a canonical tag can exist
  // and still be wrong (e.g. accidentally pointing at a different domain,
  // often a leftover from a staging/template copy). Resolved against
  // pageUrl the same way internalLinks above is, so a relative href
  // (e.g. href="/pricing") still yields a real absolute URL to compare.
  const canonicalHref = $('link[rel="canonical"]').first().attr('href') || null;
  let canonicalUrl = null;
  if (canonicalHref) {
    try { canonicalUrl = new URL(canonicalHref, pageUrl).href; } catch { /* leave null — malformed href */ }
  }

  // Accessibility signals checkable statically from real fetched HTML — no
  // headless browser needed. Color contrast, computed tap-target size, and
  // rendered font size genuinely require a rendering engine and are NOT
  // checked here — see accessibility.js's dataSources for that honest gap
  // (PageSpeed Insights' Lighthouse accessibility/seo audit categories would
  // cover them for real, but technical-seo.js's existing PSI integration
  // only requests category=performance today; adding more categories here
  // would multiply PSI's already-slow per-page call across three agents —
  // deferred, not silently skipped).
  const htmlLang = ($('html').first().attr('lang') || '').trim() || null;

  const LABELABLE_INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'search', 'password', 'number', 'date', 'textarea']);
  const labeledIds = new Set($('label[for]').map((_, el) => $(el).attr('for')).get());
  let formInputsMissingLabel = 0;
  $('input, textarea').each((_, el) => {
    const type = ($(el).attr('type') || 'text').toLowerCase();
    if ($(el).is('input') && !LABELABLE_INPUT_TYPES.has(type)) return; // hidden/submit/button/checkbox etc. — not a missing-label concern the same way
    const id = $(el).attr('id');
    const hasLabel = (id && labeledIds.has(id)) || $(el).attr('aria-label') || $(el).attr('aria-labelledby') || $(el).closest('label').length > 0;
    if (!hasLabel) formInputsMissingLabel++;
  });

  const hasAccessibleName = (el) => $(el).text().trim().length > 0 || !!$(el).attr('aria-label') || !!$(el).attr('title') || $(el).find('img[alt]').filter((_, img) => ($(img).attr('alt') || '').trim()).length > 0;
  const emptyInteractiveElements = $('button, a[href]').filter((_, el) => !hasAccessibleName(el)).length;

  const idOccurrences = new Map(); // id -> [{tag, snippet}]
  $('[id]').each((_, el) => {
    const id = $(el).attr('id');
    if (!id) return;
    if (!idOccurrences.has(id)) idOccurrences.set(id, []);
    // outerHTML truncated to a short opening-tag-ish snippet — enough for a
    // human reviewer (or duplicate-id-fix.js below) to recognize which real
    // element this is without dumping an entire component's markup into
    // agent_runs/draft content.
    const snippet = ($.html(el) || '').slice(0, 160);
    idOccurrences.get(id).push({ tag: el.tagName || el.name || 'element', snippet });
  });
  const duplicateIds = [...idOccurrences.entries()]
    .filter(([, occurrences]) => occurrences.length > 1)
    .map(([id, occurrences]) => ({ id, count: occurrences.length, occurrences: occurrences.slice(0, 5) }));
  const duplicateIdCount = duplicateIds.length;

  // A heading sequence skipping a level (e.g. h1 straight to h3, no h2) is a
  // real, commonly-flagged a11y structure issue — screen-reader users
  // navigate by heading level and a skip reads as a missing section.
  const headingLevels = $('h1, h2, h3, h4, h5, h6').map((_, el) => Number(el.tagName[1])).get();
  let headingLevelSkips = 0;
  for (let i = 1; i < headingLevels.length; i++) {
    if (headingLevels[i] - headingLevels[i - 1] > 1) headingLevelSkips++;
  }

  // Mobile-usability signals checkable statically — real viewport meta
  // content, not guessed. Tap-target sizing and legible-font-size genuinely
  // need rendering (same PSI-category gap noted above for accessibility).
  const viewportContent = ($('meta[name="viewport"]').first().attr('content') || '').trim() || null;
  const hasViewportMeta = !!viewportContent;
  const viewportHasDeviceWidth = /width\s*=\s*device-width/i.test(viewportContent || '');
  // 'no' or a maximum-scale of 1 (or less) both block pinch-zoom — a real,
  // common anti-pattern that actively hurts low-vision users, not merely a
  // missing best-practice.
  const viewportBlocksZoom = /user-scalable\s*=\s*no/i.test(viewportContent || '')
    || /maximum-scale\s*=\s*(0(\.\d+)?|1(\.0*)?)\b/i.test(viewportContent || '');

  // Page-weight signals — real counts off the actual fetched HTML, not
  // guessed. See MAX_INLINE_STYLE_COUNT/MAX_HTML_SIZE_BYTES for the
  // "worth flagging" thresholds these feed in contentGapChecks below.
  const inlineStyleCount = $('[style]').length;
  const htmlByteSize = Buffer.byteLength(html, 'utf8');

  return {
    title,
    metaDescription, // raw text — hasMetaDescription below is the boolean other callers already rely on
    hasMetaDescription: metaDescription.length >= MIN_META_DESCRIPTION_LEN,
    hasSchema: hasAnySchema,
    schemaTypes: [...schemaTypes],
    duplicateSchemaTypes, // real @types with 2+ independent JSON-LD blocks on this page — detection only, see comment above
    malformedJsonLdBlocks, // count of <script type="application/ld+json"> blocks that failed to JSON.parse
    malformedSchemaBlocks, // transient, like bodyText/imagesMissingAlt — real raw text of each block above, for generators/schema-repair.js
    schemaScriptBlocks, // transient — {raw, types}[] per real <script> tag, document order, for schema-repair.js's duplicate-removal fix to anchor an exact-match patch against
    hasFaq: hasFaqSchema || hasFaqHeading,
    hasFaqSchema, // split out from hasFaq — FAQPage schema is a stronger, machine-readable signal than a heading
    hasFaqHeading,
    hasComparisonContent: hasComparisonTable || hasComparisonHeading,
    h1Count: $('h1').length,
    h2Count: $('h2').length,
    questionHeadingCount: $('h1, h2, h3').filter((_, el) => /\?\s*$/.test($(el).text().trim())).length,
    imagesTotal: images.length,
    imagesWithoutAlt,
    imagesMissingAlt, // transient, like bodyText/internalLinks — real {src, nearbyText} pairs for alt-text.js, not meant for persisted facts
    hasCanonical: $('link[rel="canonical"]').length > 0,
    canonicalUrl, // real resolved target, null if absent or unparseable — see contentGapChecks' cross-domain check
    pageHost: host, // this page's own hostname, already resolved above for internalLinks — exposed so callers can compare canonicalUrl's host without re-parsing pageUrl
    isRootPage, // true for the homepage (no path segments) — see contentGapChecks' breadcrumbs check below
    hasOpenGraph: $('meta[property="og:title"]').length > 0 || $('meta[property="og:description"]').length > 0,
    listCount: $('ul, ol').length,
    tableCount: $('table').length,
    internalLinkCount,
    internalLinks, // transient, like bodyText — real hrefs for the technical-seo crawler, not meant for persisted facts on other callers
    wordCount,
    bodyText, // transient — callers should not persist this into stored facts (used only for LLM context); nav/header/footer/script/style already stripped, and sourced from a real content container when one is found — see extractMainText
    mainContentSelector, // transient — which MAIN_CONTENT_SELECTORS entry bodyText came from, null if it fell back to the whole (stripped) body
    htmlLang, // accessibility.js: null means no <html lang> attribute
    formInputsMissingLabel, // accessibility.js
    emptyInteractiveElements, // accessibility.js
    duplicateIdCount, // accessibility.js
    duplicateIds, // accessibility.js: [{id, count, occurrences:[{tag,snippet}]}] — real detail behind duplicateIdCount, feeds duplicate-id-fix.js's draft
    headingLevelSkips, // accessibility.js
    viewportContent, // mobile-usability.js: raw <meta name="viewport"> content, null if absent
    hasViewportMeta, // mobile-usability.js
    viewportHasDeviceWidth, // mobile-usability.js
    viewportBlocksZoom, // mobile-usability.js
    // GEO signals — see contentGapChecks below for the gap types these feed.
    hasAuthorSignal: hasAuthorSchema || hasAuthorMarkup,
    hasFreshnessSignal: hasFreshnessSchema || hasFreshnessMeta || hasFreshnessTimeTag,
    hasReviewSchema,
    externalCitationDomainCount: externalCitationDomains.size,
    hasExternalCitations: externalCitationDomains.size >= 2,
    externalCitationLinks, // transient, like internalLinks — real hrefs for technical-seo-analysis.js's crawlExternalCitations
    inlineStyleCount, // technical-seo.js: elements with a style="" attribute
    htmlByteSize, // technical-seo.js: fetched (decompressed) HTML size in bytes
  };
}

// Real title-vs-body keyword overlap — a title can pass the length checks
// above (Title length) and still not reflect what the page actually talks
// about (a stale title left over from a content rewrite, or a title written
// for a different query than what the body now covers). Same "does the real
// content back this up" philosophy as hasExternalCitations, not a guessed
// heuristic: every "topical" word is pulled straight from the title, and
// "consistent" means the body text actually contains it.
export function titleKeywordConsistency(title, bodyText) {
  const titleWords = [...new Set((title || '').toLowerCase().match(/[a-z0-9']+/g) || [])]
    .filter((w) => w.length > 2 && !TITLE_STOPWORDS.has(w));
  if (titleWords.length === 0) return { checked: false, ratio: null, missingWords: [] };
  const body = (bodyText || '').toLowerCase();
  const missingWords = titleWords.filter((w) => !body.includes(w));
  return { checked: true, ratio: (titleWords.length - missingWords.length) / titleWords.length, missingWords };
}

// Real-time answer-engine crawlers — the ones that actually fetch/browse a
// page to ground a live AI answer, or (Google-Extended/Applebot-Extended)
// opt a site into that vendor's own AI-answer features. Blocking one of
// these is a genuine citation-readiness problem. Matches EXACTLY the "must
// be Allow" list generators/llms-txt.js's own prompt defines — these two
// files must never drift on what counts as an answer-engine crawler.
//
// Deliberately EXCLUDES CCBot and Bytespider (both training-data-only
// scrapers, no live-citation role) — generators/llms-txt.js's own prompt
// calls Bytespider out by name as "training-data scraping with no citation
// benefit," and disallowing it (or CCBot) is a normal, even recommended,
// choice that has no bearing on whether this site's pages can actually be
// cited in a live AI answer. Confirmed as a real false-positive on a real
// site: a robots.txt that correctly Allow'd every answer-engine bot while
// disallowing only Bytespider was still reported as
// robotsAllowsAiCrawlers: false before this fix, because the old version
// of this list (AI_CRAWLER_AGENTS) lumped every "AI-related" token
// together regardless of whether it fetches pages for live citation.
const ANSWER_ENGINE_CRAWLER_AGENTS = ['GPTBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended'];

// Simplified robots.txt scan (line-based, not a full RFC 9309 parser): for
// each known answer-engine user-agent block, treat a bare "Disallow: /" as
// fully blocking that crawler. Anything more specific (partial paths) is
// not evaluated — this only answers "is a real answer-engine bot flatly
// disallowed site-wide".
export function robotsAllowsAiCrawlers(robotsTxt) {
  const lines = robotsTxt.split('\n').map((l) => l.trim());
  let currentAgents = [];
  let blockedAny = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      currentAgents = [value];
    } else if (key === 'disallow' && value === '/') {
      if (currentAgents.some((a) => a === '*' || ANSWER_ENGINE_CRAWLER_AGENTS.some((bot) => bot.toLowerCase() === a.toLowerCase()))) {
        blockedAny = true;
      }
    }
  }
  return !blockedAny;
}

// Response headers only — never reads the body — for security-headers.js.
// A deliberately separate, lighter fetch than fetchHtml: that one exists to
// hand back parsed HTML content, this one only ever needs whatever the
// server sent back in its response headers, which are available on the
// Response object before the body is even read.
export async function fetchResponseHeaders(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return { ok: false, error: 'invalid URL' }; }
  if (isPrivateOrLocalHost(hostname)) return { ok: false, error: 'blocked: private/local address' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0; +security-headers-agent)' },
    });
    if (!res.ok) return { ok: false, error: describeHttpFailure(res.status) };
    return { ok: true, headers: res.headers, status: res.status };
  } catch (err) {
    return { ok: false, error: describeFetchFailure('page-content.fetchResponseHeaders', err) };
  } finally {
    clearTimeout(timeout);
  }
}

// Exported for reuse by site-discovery.js (fetching robots.txt for crawl
// politeness, and each sitemap path) — same generic "fetch text from a URL,
// honestly report if it doesn't exist" shape those need, rather than a
// third copy of this fetch-with-timeout-and-guard boilerplate.
export async function fetchTextIfExists(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return { ok: false }; }
  if (isPrivateOrLocalHost(hostname)) return { ok: false };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0)' } });
    if (!res.ok) return { ok: false };
    // A 200 alone isn't proof the file exists — a client-side-routed site with
    // a catch-all fallback route returns its homepage (200, text/html) for any
    // unknown path, including llms.txt/robots.txt/sitemap.xml. None of those
    // are ever legitimately served as HTML, so that content-type is treated
    // the same as a real 404: file not found.
    const contentType = res.headers.get('content-type') || '';
    if (contentType.toLowerCase().includes('text/html')) return { ok: false };
    return { ok: true, text: await res.text() };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

// llms.txt convention (llmstxt.org) requires a top-level "# Title" heading
// and at least one markdown link — a file that exists but is plain text or
// missing links doesn't actually help AI crawlers navigate the site, even
// though a bare existence check (a 200 response) would call it "ready".
export function llmsTxtHasValidStructure(text) {
  if (!text) return false;
  const hasTitle = /^#\s+\S/m.test(text);
  const hasMarkdownLink = /\[[^\]]+\]\([^)]+\)/.test(text);
  return hasTitle && hasMarkdownLink;
}

// Site-level (not per-page) AI-crawler readiness: does /llms.txt exist, and
// does /robots.txt avoid flatly blocking major AI crawlers. Fetched once per
// agent run against the site's own root domain.
export async function checkLlmsReadiness(origin) {
  const [llms, robots] = await Promise.all([
    fetchTextIfExists(`${origin}/llms.txt`),
    fetchTextIfExists(`${origin}/robots.txt`),
  ]);
  return {
    hasLlmsTxt: llms.ok,
    // Only meaningful when hasLlmsTxt is true — a missing file is neither
    // valid nor malformed structure, it's simply absent.
    hasValidLlmsTxtStructure: llms.ok ? llmsTxtHasValidStructure(llms.text) : false,
    hasRobotsTxt: robots.ok,
    robotsAllowsAiCrawlers: robots.ok ? robotsAllowsAiCrawlers(robots.text) : null, // null = robots.txt not found, inconclusive
    robotsText: robots.ok ? robots.text : null, // real current file body — generators/llms-txt.js needs this to append to, never blindly overwrite
  };
}

// WebMCP manifest detection — an emerging, low-adoption standard for a site
// to declare real invocable actions (e.g. "add to cart", "submit form") that
// an AI browsing agent can call directly instead of simulating clicks.
// Checked the same site-level way as llms.txt/robots.txt above —
// fetchTextIfExists already guards against a catch-all SPA fallback
// returning the homepage (text/html) as a false "200 exists" for this path,
// the same class of bug this codebase already had to fix once for robots.txt
// detection. Deliberately detection-only: this tool never generates a
// manifest itself, since a real one requires knowing this site's actual
// invocable actions — a fact no page-content signal can honestly derive,
// and fabricating one would be worse than not having it (see
// ai-visibility.js's webMcpFinding — recommendedAction is always null).
export async function checkWebMcpPresence(origin) {
  const manifest = await fetchTextIfExists(`${origin}/.well-known/mcp.json`);
  return { hasManifest: manifest.ok };
}

// Site-level SSL/HTTPS enablement — two distinct real signals (a host can
// serve HTTPS while still leaving a stray non-redirecting http:// listener
// live, or not serve HTTPS at all), matching the audit tool's
// ssl-enabled/https-redirect checks. Deliberately its own fetch, not reused
// from fetchTextIfExists: that helper treats a text/html response as "not
// found" (a catch-all-SPA guard correct for llms.txt/robots.txt), which
// would misreport a perfectly normal HTML homepage as HTTPS-unreachable.
async function fetchFinalUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZunkireeAnalyticsBot/1.0)' },
    });
    return { ok: true, finalUrl: res.url };
  } catch (err) {
    return { ok: false, error: describeFetchFailure('page-content.fetchFinalUrl', err) };
  } finally {
    clearTimeout(timeout);
  }
}
export async function checkHttpsStatus(hostname) {
  if (!hostname || isPrivateOrLocalHost(hostname)) return { httpsEnabled: null, httpRedirectsToHttps: null };
  const [https, http] = await Promise.all([fetchFinalUrl(`https://${hostname}/`), fetchFinalUrl(`http://${hostname}/`)]);
  return {
    httpsEnabled: https.ok,
    // null when the plain http:// listener isn't reachable at all — many
    // hosts firewall port 80 entirely, which is a different, unremarkable
    // fact from "serves http without redirecting to https."
    httpRedirectsToHttps: http.ok ? http.finalUrl.startsWith('https://') : null,
  };
}

// Pure — one Content-Encoding header value, real gzip/br/deflate detection.
// Split out from the finding logic that calls it so it's directly testable
// without a network mock.
export function isCompressedEncoding(contentEncoding) {
  return /gzip|br|deflate/i.test(contentEncoding || '');
}

function recommendActions(analysis, query) {
  const tags = [];
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const titleHasQuery = queryTerms.length > 0 && queryTerms.some((t) => analysis.title.toLowerCase().includes(t));
  if (!titleHasQuery) tags.push('Improve title');
  if (!analysis.hasMetaDescription) tags.push('Improve meta');
  if (!analysis.hasFaq) tags.push('Add FAQ');
  if (!analysis.hasSchema) tags.push('Add schema');
  if (analysis.internalLinkCount < MIN_INTERNAL_LINKS) tags.push('Add internal links');
  if (analysis.wordCount < MIN_WORD_COUNT) tags.push('Expand content');
  return tags;
}

// Exact tag -> generator map, source of truth for the finite vocabulary
// `recommendActions()`/`contentGapChecks()` produce. Replaces the old
// downstream substring-guessing (mapToGenerator in action-center.js): every
// agent that emits one of these tags sets `recommendedAction.generatorId`
// directly from here instead of a caller re-inferring it from free text —
// so a recommendation can never silently vanish because wording didn't
// match a keyword. `null` = a real, worthwhile finding with no matching
// generator today (e.g. "expand content" has no draft-generation flow) —
// left null rather than forced onto a generator that doesn't fit.
export const TAG_TO_GENERATOR = {
  'Improve title': 'meta-title',
  'Improve meta': 'meta-title',
  'Add FAQ': 'faq',
  'Add schema': 'schema',
  'Add internal links': 'internal-links',
  'Expand content': 'expand-content',
};

export const GAP_TYPE_TO_GENERATOR = {
  'Missing FAQ': 'faq',
  'Missing schema': 'schema',
  'Missing H1': null,
  'Missing H2': null,
  'Missing comparisons': null,
  // alt-text.js exists and drafts real, grounded captions, but stays
  // 'manual' tier (risk-tiers.js) — there's no implementer capability yet
  // to splice alt="" back into arbitrary <img> tags across a target repo's
  // templates (unlike JSON-LD/array-content, which marker-merge.js and
  // data-array-content.js already know how to publish), so a human applies
  // this draft by hand today. Still worth auto-routing to for the manual
  // Generate/Submit/Approve UI instead of leaving the gap unreachable.
  'Missing alt text': 'alt-text',
  // canonical.js and open-graph.js are real, safe-tier generators
  // (risk-tiers.js) that were sitting dormant — reachable manually but never
  // auto-routed from a detected gap. Connecting them here is what actually
  // lets the Execution Engine/auto-remediation.js ship them, instead of the
  // gap only ever showing as a recommendation nothing can act on.
  'Missing canonical tag': 'canonical',
  'Canonical points to a different domain': 'canonical',
  'Missing Open Graph tags': 'open-graph',
  'Missing structured lists': null,
  // breadcrumbs.js is pure/deterministic (real URL path segments, no LLM),
  // same "safe" shape as canonical.js — real, safe-tier generator.
  'Missing breadcrumbs': 'breadcrumbs',
  'Missing question-style headings': 'qa-content',
  'Title length': 'meta-title',
  'Meta description length': 'meta-title',
  'Keyword consistency': 'meta-title',
  // GEO gaps — deliberately null on all four. Every generator that exists
  // today drafts from real evidence already on the page or a caller-given
  // param; none of these can be honestly auto-drafted without fabricating
  // the underlying fact (a real author name, a real publish date, a real
  // review/rating count, or a real external source) — informational-only
  // findings, same principle as authority.js/ai-recommendation.js.
  'Missing author/expertise signal': null,
  'Missing freshness signal': null,
  'Missing review/rating schema': null,
  'Missing external citations': null,
  // Both now have a real, exact-match-or-refuse auto-fix (schema-repair.js +
  // implementers/lib/schema-repair-inject.js) — see that generator's own
  // header comment for why "detection-only" no longer applies here.
  'Duplicate schema': 'schema-repair',
  'Invalid structured data': 'schema-repair',
};

// Effort is a property of the action itself (structural config fix vs
// net-new content), not of how important the finding is — kept as one
// honest, documented lookup instead of a per-agent guessed constant.
const GENERATOR_EFFORT = {
  'meta-title': 'Low', faq: 'Low', 'qa-content': 'Low', schema: 'Low', 'internal-links': 'Low', 'llms-txt': 'Low',
  'analytics-install': 'Low',
  'security-headers': 'Low', 'html-lang': 'Low', sitemap: 'Low',
  viewport: 'Low', canonical: 'Low', 'robots-fix': 'Low', 'open-graph': 'Low',
  'broken-link-fix': 'Low', 'redirect-fix': 'Low', breadcrumbs: 'Low', 'alt-text': 'Low',
  'blog-outline': 'High', 'landing-page': 'High', translation: 'High', 'expand-content': 'High', 'direct-answer': 'High',
  'cookie-policy': 'High', 'privacy-policy': 'High', 'terms-of-service': 'High',
};
export const effortForGenerator = (generatorId) => GENERATOR_EFFORT[generatorId] || 'Medium';

// Best-effort schema type for an "Add schema markup" recommendation — never
// blindly 'Article'. Prefers a real signal already on the page (an existing
// JSON-LD @type from analyzePage's schemaTypes, even if incomplete/partial)
// over a URL-path guess, and only falls back to 'Article' when neither applies.
// Boilerplate types (site-wide Organization/WebSite/BreadcrumbList markup)
// are skipped since they say nothing about this specific page's content type.
const BOILERPLATE_SCHEMA_TYPES = new Set(['Organization', 'WebSite', 'BreadcrumbList', 'WebPage']);
const PATH_SCHEMA_HINTS = [
  [/\/(products?|shop|store)\//i, 'Product'],
  [/\/(faq|faqs)(\/|$)/i, 'FAQPage'],
  [/\/(contact|contact-us)(\/|$)/i, 'ContactPage'],
  [/\/(about|about-us|company)(\/|$)/i, 'AboutPage'],
  [/\/(blog|articles?|news)\//i, 'Article'],
];
export function inferSchemaType(pageUrl, schemaTypes = []) {
  const existing = (schemaTypes || []).find((t) => t && !BOILERPLATE_SCHEMA_TYPES.has(t));
  if (existing) return existing;
  let path = '';
  try { path = new URL(pageUrl).pathname; } catch { /* leave path empty, fall through to default */ }
  for (const [re, type] of PATH_SCHEMA_HINTS) if (re.test(path)) return type;
  // A bare root path is a homepage far more often than it's an article — the
  // generic 'Article' fallback below is wrong for exactly this common case
  // (confirmed in practice: a SaaS app's homepage failed Article generation
  // outright, since there's no headline/body to write an article about).
  // 'Organization' is BOILERPLATE_SCHEMA_TYPES-listed above only for
  // skipping an *already-existing* type that says nothing page-specific —
  // it's still the right type to recommend *adding* when nothing exists yet.
  if (path === '/' || path === '') return 'Organization';
  return 'Article';
}

// Deterministic on-page completeness gaps for the Content Gap Agent — every
// item here is verified directly from the page's real fetched HTML (unlike
// the AI-inferred entity suggestions the agent adds separately). `queryTexts`
// gates the comparison check: a comparison section is only "missing" if ANY
// of the page's real top ranking queries signals comparison intent — not
// just the single #1 query, since comparison intent often shows up further
// down the page's own query list (e.g. #1 is a brand query, #2 is "x vs y").
function contentGapChecks(analysis, queryTexts = []) {
  const queries = Array.isArray(queryTexts) ? queryTexts : [queryTexts];
  const gaps = [];
  if (analysis.h1Count === 0) gaps.push({ type: 'Missing H1', detail: 'No H1 heading found.' });
  else if (analysis.h1Count > 1) gaps.push({ type: 'Missing H1', detail: `${analysis.h1Count} H1 tags found — should be exactly one.` });
  if (analysis.h2Count === 0) gaps.push({ type: 'Missing H2', detail: 'No H2 subheadings — thin content structure.' });

  if (!analysis.hasFaq) gaps.push({ type: 'Missing FAQ', detail: 'No FAQ schema, heading, or Q&A accordion detected.' });
  if (!analysis.hasSchema) gaps.push({ type: 'Missing schema', detail: 'No structured data (JSON-LD) found on the page.' });

  const titleLen = analysis.title?.length || 0;
  if (titleLen === 0) gaps.push({ type: 'Title length', detail: 'No <title> tag content found.' });
  else if (titleLen < MIN_TITLE_LEN) gaps.push({ type: 'Title length', detail: `Title is ${titleLen} characters — usually too short/generic (target ${MIN_TITLE_LEN}-${MAX_TITLE_LEN}).` });
  else if (titleLen > MAX_TITLE_LEN) gaps.push({ type: 'Title length', detail: `Title is ${titleLen} characters — Google typically truncates past ${MAX_TITLE_LEN}.` });

  if (!analysis.hasMetaDescription) {
    gaps.push({ type: 'Meta description length', detail: analysis.metaDescription.length === 0 ? 'No meta description found.' : `Meta description is ${analysis.metaDescription.length} characters — below the ${MIN_META_DESCRIPTION_LEN}-character recommended minimum.` });
  } else {
    const descLen = analysis.metaDescription.length;
    if (descLen > MAX_META_DESCRIPTION_LEN) gaps.push({ type: 'Meta description length', detail: `Meta description is ${descLen} characters — Google typically truncates past ${MAX_META_DESCRIPTION_LEN}.` });
  }

  const comparisonQuery = queries.find((q) => /\bvs\.?\b|\bversus\b|\bcompar(e|ison)\b|\bbest\b/i.test(q));
  if (comparisonQuery && !analysis.hasComparisonContent) {
    gaps.push({ type: 'Missing comparisons', detail: `Ranking query "${comparisonQuery}" signals comparison intent, but no comparison table or section was found.` });
  }

  if (analysis.imagesTotal > 0 && analysis.imagesWithoutAlt > 0) {
    gaps.push({ type: 'Missing alt text', detail: `${analysis.imagesWithoutAlt}/${analysis.imagesTotal} images have no alt text.` });
  }
  if (!analysis.hasCanonical) {
    gaps.push({ type: 'Missing canonical tag', detail: 'No rel="canonical" link found.' });
  } else if (analysis.canonicalUrl && analysis.pageHost) {
    // A canonical present but resolving to a different domain is almost
    // always an accident (a leftover from a staging/template copy) rather
    // than intentional — a real, distinct issue from "no canonical at all,"
    // and one GSC's own index-status check (technical-seo.js) can't catch on
    // its own since it only compares Google's chosen canonical against
    // whatever this page declares, not whether that declaration itself
    // looks like a mistake.
    let canonicalHost = null;
    try { canonicalHost = new URL(analysis.canonicalUrl).hostname; } catch { /* leave null — already-invalid canonicalUrl */ }
    if (canonicalHost && canonicalHost !== analysis.pageHost) {
      gaps.push({ type: 'Canonical points to a different domain', detail: `Canonical tag points to "${analysis.canonicalUrl}" — a different domain than this page (${analysis.pageHost}).` });
    }
  }
  const keywordConsistency = titleKeywordConsistency(analysis.title, analysis.bodyText);
  if (keywordConsistency.checked && keywordConsistency.ratio < 0.5) {
    gaps.push({ type: 'Keyword consistency', detail: `Title's key terms barely appear in the page body (missing: ${keywordConsistency.missingWords.join(', ')}) — the title may no longer reflect what the page actually covers.` });
  }
  if (!analysis.hasOpenGraph) gaps.push({ type: 'Missing Open Graph tags', detail: 'No og:title/og:description found.' });
  // Deterministic from the real URL path (breadcrumbs.js), not the LLM —
  // same "pure, safe" shape as canonical.js. A homepage/root URL has no real
  // trail to draft, and breadcrumbs.js refuses that case explicitly rather
  // than fabricating one — so skip the gap here too (same guaranteed-to-fail
  // class as aff6ef5/8115f21: a recommendation shown "SAFE — AUTO-ELIGIBLE"
  // that fails on every approval attempt, for every root page, forever).
  if (!analysis.isRootPage && !(analysis.schemaTypes || []).includes('BreadcrumbList')) {
    gaps.push({ type: 'Missing breadcrumbs', detail: 'No BreadcrumbList structured data found.' });
  }
  // Detection only — deciding which of two same-@type blocks is the real
  // one, or fixing malformed JSON syntax in a live template, requires
  // knowing the template's actual rendering, not a fact any generator here
  // can derive. Genuinely needs a human, not a missing generator.
  if (analysis.duplicateSchemaTypes?.length) {
    gaps.push({ type: 'Duplicate schema', detail: `This page has more than one JSON-LD block of the same type: ${analysis.duplicateSchemaTypes.join(', ')}.` });
  }
  if (analysis.malformedJsonLdBlocks > 0) {
    gaps.push({ type: 'Invalid structured data', detail: `${analysis.malformedJsonLdBlocks} JSON-LD <script> block(s) on this page failed to parse as valid JSON.` });
  }
  if (analysis.listCount === 0) gaps.push({ type: 'Missing structured lists', detail: 'No ordered/unordered lists — lists help answer-engine extraction.' });
  if (analysis.questionHeadingCount === 0) gaps.push({ type: 'Missing question-style headings', detail: 'No headings phrased as questions — reduces AEO/featured-snippet eligibility.' });

  // GEO (Generative Engine Optimization) gaps — confirmed via a cross-check
  // against the sibling audit tool's geo checks (authorExpertise.js,
  // freshnessSignals.js, reviewRatingSchema.js, externalCitations.js): real,
  // previously-uncovered signals in what AI assistants weigh when deciding
  // what to cite/recommend, on top of the classic SEO gaps above.
  if (!analysis.hasAuthorSignal) {
    gaps.push({ type: 'Missing author/expertise signal', detail: 'No author schema, rel="author", itemprop="author", meta author tag, or visible byline found — unattributed content is less likely to be cited by generative engines.' });
  }
  if (!analysis.hasFreshnessSignal) {
    gaps.push({ type: 'Missing freshness signal', detail: 'No publish or last-updated date found (no datePublished/dateModified schema, article date meta tags, or a <time> element) — generative engines favor recently-updated content when choosing what to cite.' });
  }
  if (!analysis.hasReviewSchema) {
    gaps.push({ type: 'Missing review/rating schema', detail: 'No Review or AggregateRating schema found — this is only worth adding if the page has real reviews/ratings to mark up; never fabricate rating data to fill this gap.' });
  }
  if (!analysis.hasExternalCitations) {
    gaps.push({
      type: 'Missing external citations',
      detail: analysis.externalCitationDomainCount === 1
        ? 'Only 1 distinct external domain linked — add a few more authoritative sources.'
        : 'No links to external, authoritative sources found in the page content — AI assistants favor well-sourced content when deciding what to reuse or recommend.',
    });
  }

  return gaps;
}

// Fetches and analyzes `url` once, returning a reusable base analysis. Pass
// the same result into recommendationsFor() for every query that lands on
// this page, so shared pages aren't re-fetched.
export async function analyzePageUrl(url) {
  const fetched = await fetchHtml(url);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  return { ok: true, analysis: analyzePage(fetched.html, url) };
}

// Query-specific recommendations (title match depends on the query) built
// from an already-fetched page's analysis.
export function recommendationsFor(analysis, query) {
  return recommendActions(analysis, query);
}

// Deterministic content-completeness gaps (headings/FAQ/schema/comparisons/
// alt-text/canonical/OG/lists/question-headings) for the Content Gap Agent.
// `queryTexts` is the page's list of real top ranking queries (comparison
// intent is checked across all of them, not just the #1 query).
export function contentGapsFor(analysis, queryTexts) {
  return contentGapChecks(analysis, queryTexts);
}
