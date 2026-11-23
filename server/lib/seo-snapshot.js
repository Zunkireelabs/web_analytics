import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

// The SEO-critical facts of one page, extracted from its HTML and response headers: the "snapshot" the drift monitor compares
// against a baseline (agents/seo-drift.js, agents/lib/seo-drift-rules.js). Pure: HTML in, plain fields out, no network.
//
// Which elements and how drift is judged follows claude-seo's seo-drift skill (MIT, (c) 2026 agricidaniel; the baseline elements
// and the 17 comparison rules), adapted to this codebase. Differences worth knowing:
//  - the content hash is of normalized VISIBLE TEXT (scripts, styles and comments removed, digits masked), not of raw HTML.
//    Raw HTML changes on every request (nonces, timestamps, tokens); a hash of it would "drift" nightly on every dynamic site.
//  - only what a plain fetch sees is captured. A page whose content is drawn by JavaScript shows as an empty shell both times,
//    so it never drifts; it is not falsely flagged, but it is not watched either.

const sha = (s) => createHash('sha256').update(s).digest('hex');
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const UTM = /^(utm_[a-z]+|gclid|fbclid|msclkid)$/i;

// Stable key for matching a page across runs: scheme and host lowercased, fragment and tracking parameters dropped, remaining
// parameters sorted. The path is left exactly as written (a trailing slash is a real, distinct URL; GSC reports it consistently).
export function normalizePageUrl(input) {
  const u = new URL(input);
  u.hash = '';
  const keep = [...u.searchParams.entries()].filter(([k]) => !UTM.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  return u.toString();
}

// JSON with sorted keys, so two structurally equal blocks hash the same however their keys were ordered.
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function collectTypes(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => collectTypes(n, out)); return; }
  if (!node || typeof node !== 'object') return;
  const t = node['@type'];
  if (typeof t === 'string') out.add(t); else if (Array.isArray(t)) t.filter((x) => typeof x === 'string').forEach((x) => out.add(x));
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectTypes(v, out);
}

function robotsDirectives($, headers) {
  const set = new Set();
  const add = (v) => String(v || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => set.add(x));
  $('meta').each((_, el) => {
    const name = String($(el).attr('name') || '').toLowerCase();
    if (name === 'robots' || name === 'googlebot') add($(el).attr('content'));
  });
  add(headers?.['x-robots-tag']);
  return [...set].sort().join(', ') || null;
}

/**
 * @param html        the response body (string), or null/'' when there is none
 * @param statusCode  final HTTP status after redirects
 * @param headers     response headers, lowercase keys
 * @param pageUrl     the URL the page was fetched from (to resolve a relative canonical)
 */
export function extractSnapshot({ html, statusCode = null, headers = {}, pageUrl } = {}) {
  const body = typeof html === 'string' ? html : '';
  const $ = cheerio.load(body);

  const text = (sel) => $(sel).map((_, el) => collapse($(el).text())).get().filter(Boolean);
  const title = collapse($('head title').first().text() || $('title').first().text()) || null;
  const metaDescription = collapse($('meta[name="description"]').first().attr('content')) || null;

  const canonicalRaw = collapse($('link[rel="canonical"]').first().attr('href'));
  let canonical = null;
  if (canonicalRaw) { try { canonical = normalizePageUrl(new URL(canonicalRaw, pageUrl).toString()); } catch { canonical = canonicalRaw; } }

  // Structured data: the @type values (for "was removed / was added") and a hash of the blocks (for "was modified").
  const blocks = [];
  const types = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = ($(el).contents().text() || '').trim();
    if (!raw) return;
    try { const parsed = JSON.parse(raw); blocks.push(stableStringify(parsed)); collectTypes(parsed, types); }
    catch { blocks.push(`raw:${collapse(raw)}`); } // unparsable still counts as "something is there", and a change to it still changes the hash
  });
  const schemaHash = blocks.length ? sha(blocks.sort().join('\n')) : null;

  const openGraph = {};
  $('meta[property^="og:"]').each((_, el) => {
    const k = String($(el).attr('property') || '').toLowerCase();
    const v = collapse($(el).attr('content'));
    if (k && v) openGraph[k] = v;
  });

  // Visible text only: everything that varies per request but is not content (scripts, styles, comments) is removed first, and
  // digit runs are masked so a date, a counter or "3 comments" does not read as a content change.
  const $c = cheerio.load(body);
  $c('script, style, noscript, svg, iframe, template').remove();
  $c('*').contents().filter((_, n) => n.type === 'comment').remove();
  const visible = collapse(($c('body').length ? $c('body') : $c.root()).text()).toLowerCase().replace(/\d+/g, '#');
  const words = visible ? visible.split(' ').length : 0;

  return {
    statusCode: Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
    title, metaDescription, canonical,
    robots: robotsDirectives($, headers),
    h1: text('h1'), h2: text('h2'),
    schemaTypes: [...types].sort(), schemaHash,
    openGraph,
    contentHash: visible ? sha(visible) : null,
    wordCount: words,
  };
}
