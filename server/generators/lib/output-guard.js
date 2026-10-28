// Pre-ship validator for generator output: the defects below were written into
// published client blog posts (zunkireelabs-web) and had to be removed by hand.
// Everything here is pure and DB-free, so the same checks can run at the three
// points content can enter a file — the Quality Gate (generation + approval),
// expand-content's own regenerate-once loop, and marker-merge's
// buildMergeValues (hand-built and auto-built drafts alike).
//
//   1. EMPTY WRAPPER   a div/section with no text, image or child — renders as
//                      a blank bordered strip
//   2. BAD JSON-LD     invalid JSON, scraped navigation text, or a
//                      Review/AggregateRating schema (self-review of the
//                      client's own content)
//   3. BAD TABLE       no header row, an empty header cell, an all-empty row,
//                      or filler: unnamed "Alternative" columns / hedged cells
//   4. BAD ANCHOR      an internal-link anchor that doesn't overlap the target
//                      page's real title/H1/slug, or a target that doesn't
//                      resolve in the site's url_file_map
//   5. EMPTY MARKER    a marker value that would be written empty
//
// Issues are { path, patternId, snippet, correction } — the same shape every
// sibling guard returns to runQualityGate, with `correction` so the existing
// repair loop (design-repair-feedback.js) can route it back to the generator.
//
// Ported from zunkireelabs-web/scripts/check-content-quality.mjs (which checks
// the same things in Markdown posts after the fact); not imported across repos.
import { findScaffoldingIssues } from './content-scaffolding-guard.js';

const issue = (path, patternId, snippet, correction) => ({
  path, patternId, snippet: String(snippet).slice(0, 120), correction,
});

// ---------------------------------------------------------------------------
// 1. Empty wrappers
// ---------------------------------------------------------------------------
const WRAPPER_TAGS = 'div|section|article|aside|ul|ol|blockquote';
const EMPTY_WRAPPER_RE = new RegExp(`<(${WRAPPER_TAGS})\\b[^>]*>(?:\\s|&nbsp;|<!--[\\s\\S]*?-->)*</\\1>`, 'i');
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

// A site's own template can legitimately carry an empty decorative element (a
// divider bar, a spacer, an accent line). Those are drawn by their class or are
// hidden from assistive tech on purpose, so they are never the blank strip this
// guards against; a "card" (padding plus a background or border) that is empty
// always is.
function isDecorative(el) {
  const open = el.slice(0, el.indexOf('>') + 1);
  if (/\baria-hidden=["']true["']|\brole=["'](presentation|separator|none)["']/i.test(open)) return true;
  const cls = /\bclass=["']([^"']*)["']/i.exec(open)?.[1] || '';
  if (/\b(divider|separator|spacer|rule|accent|dot|icon|line|bar|gap|clearfix)\b/i.test(cls)) return true;
  const cardLike = /\bp[xytblr]?-\d/.test(cls) && /\b(bg-|border)/.test(cls);
  return !cardLike && /\b(h-(px|\d+)|w-(px|\d+)|border-[tb])\b/.test(cls) && !/\bp[xy]?-\d/.test(cls);
}

export function findEmptyWrappers(html, path = '') {
  if (typeof html !== 'string' || !html.includes('<')) return [];
  // A wrapper that only contains empty wrappers is empty too, so collapse
  // inside-out until nothing changes and report the first empty one found.
  let work = html;
  let first = null;
  for (let i = 0; i < 20; i++) {
    const m = EMPTY_WRAPPER_RE.exec(work);
    if (!m) break;
    if (!isDecorative(m[0])) first = first || m[0];
    work = work.slice(0, m.index) + work.slice(m.index + m[0].length);
  }
  const out = [];
  if (first) {
    out.push(issue(path, 'empty-wrapper', first,
      'Never emit a wrapper element (div/section/list) with nothing inside it; every block must contain real text.'));
  } else if (html.trim() && !/<(img|svg|iframe|video|picture|hr|table|script|link|meta)\b/i.test(html)
    && !stripComments(html).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()) {
    // Markup with tags but no visible text at all.
    out.push(issue(path, 'empty-wrapper', html.trim(), 'The output contains markup but no visible text.'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. JSON-LD
// ---------------------------------------------------------------------------
const LD_BLOCK_RE = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const NAV_WORDS = ['home', 'products', 'solutions', 'pricing', 'about', 'contact', 'blog', 'resources', 'login', 'sign in', 'careers', 'menu', 'services', 'company', 'docs'];
const SELF_REVIEW_TYPES = new Set(['review', 'aggregaterating']);
// What a review may legitimately be ABOUT. A review whose subject is the page, the
// article or the site itself (or has no subject) is the self-review defect.
const REVIEWABLE_TYPES = new Set(['product', 'service', 'localbusiness', 'organization', 'course', 'softwareapplication', 'movie', 'book', 'recipe', 'event', 'restaurant', 'hotel']);
const typesOf = (n) => [].concat(n?.['@type'] || []).map((t) => String(t).toLowerCase());

function walkLd(node, visit, parent = null) {
  if (Array.isArray(node)) { node.forEach((n) => walkLd(n, visit, parent)); return; }
  if (node && typeof node === 'object') {
    visit(node, parent);
    Object.values(node).forEach((v) => walkLd(v, visit, node));
  }
}

// A Review/AggregateRating is a self-review when what it rates is the content itself.
function isSelfReview(node, parent) {
  const subject = node.itemReviewed || (parent && !SELF_REVIEW_TYPES.has(typesOf(parent)[0]) ? parent : null);
  const subjectTypes = typesOf(subject);
  if (!subjectTypes.length) return true; // rates nothing identifiable
  return !subjectTypes.some((t) => REVIEWABLE_TYPES.has(t));
}

function navLikeString(s) {
  if (typeof s !== 'string') return false;
  if (findScaffoldingIssues(s).some((i) => i.patternId === 'nav-leakage')) return true;
  // A run of menu labels with no sentence punctuation: scraped chrome, not prose.
  const lower = ` ${s.toLowerCase()} `;
  const hits = NAV_WORDS.filter((w) => lower.includes(` ${w} `)).length;
  return hits >= 5 && !/[.!?]\s/.test(s);
}

export function findJsonLdObjectIssues(data, path = 'jsonLd') {
  const out = [];
  if (data == null || typeof data !== 'object') {
    return [issue(path, 'jsonld-empty', String(data), 'The structured data is empty; omit it instead of writing an empty block.')];
  }
  const keys = Array.isArray(data) ? data : Object.keys(data).filter((k) => k !== '@context');
  if (!keys.length) {
    out.push(issue(path, 'jsonld-empty', JSON.stringify(data), 'The structured data is empty; omit it instead of writing an empty block.'));
  }
  let navHit = null;
  let selfReview = null;
  walkLd(data, (obj, parent) => {
    for (const t of typesOf(obj)) {
      if (SELF_REVIEW_TYPES.has(t) && isSelfReview(obj, parent)) selfReview = selfReview || t;
    }
    for (const v of Object.values(obj)) if (!navHit && navLikeString(v)) navHit = v;
  });
  if (navHit) {
    out.push(issue(path, 'jsonld-scraped-navigation', navHit,
      'Structured data must come from the page\'s real content, never from its menu or footer text.'));
  }
  if (selfReview) {
    out.push(issue(path, 'jsonld-self-review', selfReview,
      'Do not emit a Review or AggregateRating schema about the client\'s own content.'));
  }
  return out;
}

export function findJsonLdIssues(html, path = '') {
  if (typeof html !== 'string') return [];
  const out = [];
  for (const m of html.matchAll(LD_BLOCK_RE)) {
    const body = m[1].trim();
    if (!body) { out.push(issue(path, 'jsonld-empty', '<script ld+json></script>', 'The structured data block is empty; omit it.')); continue; }
    let data;
    try { data = JSON.parse(body); } catch {
      out.push(issue(path, 'jsonld-invalid', body.slice(0, 80), 'The structured data is not valid JSON.'));
      continue;
    }
    out.push(...findJsonLdObjectIssues(data, path));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Tables
// ---------------------------------------------------------------------------
const GENERIC_COLUMN_RE = /^(alternatives?|competitors?|others?|option|options|this[_ ]option|competitor[_ ]?\w?|option[_ ]?\w?|brand[_ ]?\w?|other[_ ]option)$/i;
const HEDGE_RE = /^\s*(may|might|could|varies|vary|depends|focus may|focus might)\b/i;

function structuredTableIssues(table, path) {
  const out = [];
  if (!Array.isArray(table) || !table.length) return out;
  const columns = Object.keys(table[0] || {});
  if (!columns.length) {
    return [issue(path, 'table-no-header', '[]', 'A table needs a header row naming its columns.')];
  }
  columns.slice(1).forEach((c) => {
    if (!String(c).trim()) out.push(issue(path, 'table-empty-header', '(empty)', 'Every table column after the first needs a header.'));
  });
  for (const row of table) {
    if (columns.every((c) => String(row?.[c] ?? '').trim() === '')) {
      out.push(issue(path, 'table-empty-row', '(empty row)', 'Remove rows with no content.'));
      break;
    }
  }
  const generic = columns.filter((c) => GENERIC_COLUMN_RE.test(String(c).trim()));
  if (generic.length) {
    out.push(issue(path, 'table-unnamed-competitor', generic.join(', '),
      'Do not compare the client against an unnamed "Alternative"/"Competitor" column; only compare against real, named options found in the page text, or omit the table.'));
  }
  const valueCells = table.flatMap((row) => columns.slice(1).map((c) => String(row?.[c] ?? '')));
  if (valueCells.length >= 2) {
    const hedged = valueCells.filter((v) => HEDGE_RE.test(v)).length;
    if (hedged >= 2 && hedged / valueCells.length >= 0.5) {
      out.push(issue(path, 'table-filler', valueCells.find((v) => HEDGE_RE.test(v)),
        'Table cells must state grounded facts, not hedged generalities ("may focus on…").'));
    }
  }
  return out;
}

function htmlTableIssues(html, path) {
  const out = [];
  for (const t of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const table = t[0];
    if (!/<thead\b/i.test(table) && !/<th\b/i.test(table)) {
      out.push(issue(path, 'table-no-header', table.slice(0, 80), 'A table needs a header row.'));
    }
    const headCells = [...(table.match(/<thead\b[\s\S]*?<\/thead>/i)?.[0] || '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)];
    if (headCells.slice(1).some((c) => !c[1].replace(/<[^>]*>/g, '').trim())) {
      out.push(issue(path, 'table-empty-header', table.slice(0, 80), 'Every table column after the first needs a header.'));
    }
    for (const r of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)];
      if (cells.length && cells.every((c) => !c[1].replace(/<[^>]*>/g, '').trim())) {
        out.push(issue(path, 'table-empty-row', r[0].slice(0, 80), 'Remove rows with no content.'));
        break;
      }
    }
  }
  return out;
}

// GFM pipe tables inside a body string. The |---|---| separator is skipped; an
// empty FIRST header cell is a normal row-label column, an empty header
// elsewhere or a row with no text at all is a broken table.
function markdownTableIssues(text, path) {
  const rows = text.split('\n').filter((l) => /^\|.*\|\s*$/.test(l) && !/^\|[\s:|-]+\|\s*$/.test(l));
  for (const [i, line] of rows.entries()) {
    const cells = line.trim().slice(1, -1).split(/(?<!\\)\|/);
    const isHeader = i === 0 || !/^\|/.test(rows[i - 1] || '');
    if (cells.every((c) => c.trim() === '') || (isHeader && cells.slice(1).some((c) => c.trim() === ''))) {
      return [issue(path, 'table-empty-header', line.slice(0, 80), 'A table needs a header row and no empty rows.')];
    }
  }
  return [];
}

const FILLER_HEADING_RE = /\bcompetitors?\s+(for|of|in|to)\b/i;

// ---------------------------------------------------------------------------
// Content walk (structured generator output) and rendered fragments
// ---------------------------------------------------------------------------
function walk(value, path, visit) {
  if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`, visit)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, visit);
  }
  visit(value, path);
}

// Structured generator content ({sections:[{heading, body, table}], jsonLd,
// schemaJsonLd, ...}) as produced BEFORE rendering.
export function findContentIssues(content) {
  const out = [];
  if (!content || typeof content !== 'object') return out;
  for (const [i, s] of (Array.isArray(content.sections) ? content.sections : []).entries()) {
    const base = `sections[${i}]`;
    if (s && typeof s === 'object') {
      if (typeof s.heading === 'string' && FILLER_HEADING_RE.test(s.heading) && Array.isArray(s.table)) {
        out.push(issue(`${base}.heading`, 'competitor-profile-heading', s.heading,
          'Do not profile competitors on the client\'s own page; compare only real, named options from the page text.'));
      }
      out.push(...structuredTableIssues(s.table, `${base}.table`));
      if (typeof s.body === 'string') out.push(...markdownTableIssues(s.body, `${base}.body`));
    }
  }
  for (const key of ['jsonLd', 'schemaJsonLd']) {
    if (content[key] !== undefined) out.push(...findJsonLdObjectIssues(content[key], key));
  }
  walk(content, '', (v, path) => {
    if (typeof v !== 'string') return;
    if (v.includes('<')) out.push(...findEmptyWrappers(v, path), ...findJsonLdIssues(v, path), ...htmlTableIssues(v, path));
    if (v.includes('|') && !/sections\[\d+\]\.body$/.test(path)) out.push(...markdownTableIssues(v, path));
  });
  return out;
}

// A final rendered value about to be spliced into a marker.
export function findRenderedIssues(html, path = '') {
  if (typeof html !== 'string') return [];
  return [...findEmptyWrappers(html, path), ...findJsonLdIssues(html, path), ...htmlTableIssues(html, path)];
}

// ---------------------------------------------------------------------------
// 4. Internal-link anchors
// ---------------------------------------------------------------------------
const STOP = new Set(['the', 'and', 'for', 'with', 'your', 'our', 'you', 'are', 'how', 'what', 'why', 'best', 'guide', 'from', 'that', 'this', 'into', 'about', 'more', 'page', 'learn', 'read', 'click', 'here', 'a', 'an', 'of', 'to', 'in', 'on', 'is', 'it', 'or', 'by', 'at', 'as']);
const stem = (w) => w.replace(/(ing|ed|es|s)$/i, '');
const tokens = (s) => new Set(
  String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w)).map(stem),
);

// A link's anchor has to describe where it goes. `targetTitle` is the page's
// real title/H1 when known (internal-links.js records it); the URL slug is
// always available, so a hand-built draft with no title is still checked.
export function anchorOverlapsTarget(anchorText, targetUrl, targetTitle = '') {
  const a = tokens(anchorText);
  if (!a.size) return false;
  let slug = '';
  try { slug = new URL(targetUrl, 'https://x.invalid').pathname; } catch { slug = String(targetUrl || ''); }
  const t = new Set([...tokens(targetTitle), ...tokens(slug)]);
  // Same word, or one a prefix of the other ("winning" ~ "winner"), so plain
  // inflection never reads as a mismatch.
  const same = (x, y) => x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)));
  let shared = 0;
  for (const w of a) if ([...t].some((u) => same(w, u))) shared++;
  return shared >= 1 && shared >= Math.ceil(a.size / 2);
}

export function findLinkSuggestionIssues(suggestions, { resolves = null } = {}) {
  const out = [];
  (Array.isArray(suggestions) ? suggestions : []).forEach((s, i) => {
    const path = `suggestions[${i}]`;
    const anchor = typeof s?.anchorText === 'string' ? s.anchorText.trim() : '';
    if (!anchor || !String(s?.targetUrl || '').trim()) {
      out.push(issue(path, 'link-empty', anchor || '(no anchor)', 'A link needs both anchor text and a target URL.'));
      return;
    }
    if (!anchorOverlapsTarget(anchor, s.targetUrl, s.targetTitle)) {
      out.push(issue(`${path}.anchorText`, 'link-anchor-mismatch', anchor,
        `The anchor "${anchor}" does not describe the target page. Build the anchor from the target page's real title or H1.`));
    }
    if (resolves && !resolves(s.targetUrl)) {
      out.push(issue(`${path}.targetUrl`, 'link-target-unresolved', s.targetUrl,
        'The target URL does not resolve to a real page in this site\'s url_file_map.'));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// 5. Marker values about to be written
// ---------------------------------------------------------------------------
export function isEmptyMarkerValue(value) {
  if (value == null) return true;
  if (typeof value === 'string') {
    const v = value.trim();
    return v === '' || /^<script\b[^>]*ld\+json[^>]*>\s*(\{\s*\}|\[\s*\])?\s*<\/script>$/i.test(v);
  }
  if (typeof value === 'object') return Object.values(value).every(isEmptyMarkerValue);
  return false;
}

// `values` is buildMergeValues' { field: string | {block,line} } map. Only
// string values are inspected as markup; an object value (canonical) is only
// checked for emptiness.
export function findMergeValueIssues(values, { suggestions = null, resolves = null } = {}) {
  const out = [];
  for (const [field, value] of Object.entries(values || {})) {
    if (isEmptyMarkerValue(value)) {
      out.push(issue(field, 'marker-empty', '(empty)', 'This marker would be written empty; skip it instead.'));
      continue;
    }
    if (typeof value === 'string') out.push(...findRenderedIssues(value, field));
  }
  if (suggestions) out.push(...findLinkSuggestionIssues(suggestions, { resolves }));
  return out;
}

export function describeIssues(issues) {
  return [...new Set(issues.map((i) => `${i.patternId}${i.snippet ? ` ("${i.snippet}")` : ''}`))].slice(0, 6).join('; ');
}
