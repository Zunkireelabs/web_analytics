// ONE acceptance test for blog pagination, for every stack. It looks only at the BUILT HTML of a site (Astro's dist, Eleventy's _site, Next's
// out, Hugo's public: any static output), never at source code, so a recipe for any framework is held to exactly the same bar.
//
// What "correct" means, in plain terms:
//   1. Every blog post that was listed before is still reachable from the listing, exactly once across all pages (nothing lost, nothing doubled).
//   2. Each listing page has its own canonical (itself, never page 1), and the rel="prev"/"next" chain runs unbroken from first page to last.
//   3. Titles and meta descriptions are unique across the listing pages.
//   4. Every pager link lands on a page that exists.
//   5. The sitemap (when given) lists every post (a problem if not) and every listing page (advisory).
//   6. (When a baseline build of the same site is given) nothing outside the listing pages and the sitemap changed.
//
// Pure functions over a Map of route -> html, so they are tested without a browser, a build or the network. loadBuiltSite() reads a build
// directory into that Map. Routes are normalised without a trailing slash ("/blog/page/2"), and "/" stays "/".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as cheerio from 'cheerio';

export const normRoute = (p) => {
  let path = String(p || '/').split('#')[0].split('?')[0];
  try { if (/^https?:/i.test(path)) path = new URL(path).pathname; } catch { /* keep */ }
  path = path.replace(/\/index\.html$/i, '/').replace(/\.html$/i, '');
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
};

export function loadBuiltSite(dir) {
  const pages = new Map(), other = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) { if (!['_astro', 'assets', 'node_modules'].includes(name)) walk(full); continue; }
      const rel = relative(dir, full).split(sep).join('/');
      if (/\.html$/i.test(name)) pages.set(normRoute(`/${rel}`), readFileSync(full, 'utf8'));
      else if (/\.xml$/i.test(name)) other.set(`/${rel}`, readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return { pages, files: other };
}

const parse = (html) => cheerio.load(html);
const attr = ($, sel, name) => $(sel).first().attr(name) ?? null;

// Facts about one page: where it says it is, where it says its neighbours are, what it lists.
export function describePage(html, { origin, postPrefix }) {
  const $ = parse(html);
  const abs = (h) => (h ? normRoute(new URL(h, origin).href) : null);
  const posts = new Set();
  $('a[href]').each((_, a) => {
    const route = abs($(a).attr('href'));
    if (route && postPrefix.test(route)) posts.add(route);
  });
  return {
    title: $('title').first().text().trim(),
    description: attr($, 'meta[name="description"]', 'content'),
    canonical: abs(attr($, 'link[rel="canonical"]', 'href')),
    // rel="prev"/"next" may be a <link> in the head or the pager's own <a>: both are valid ways to say it.
    prev: abs(attr($, 'link[rel="prev"]', 'href') ?? attr($, 'a[rel~="prev"]', 'href')),
    next: abs(attr($, 'link[rel="next"]', 'href') ?? attr($, 'a[rel~="next"]', 'href')),
    hrefs: $('a[href]').map((_, a) => abs($(a).attr('href'))).get().filter(Boolean),
    posts,
  };
}

/**
 * @param {object} p
 * @param {Map<string,string>} p.built          route -> html of the NEW build
 * @param {string} p.origin                      https://example.com
 * @param {string} p.firstPage                   route of page 1, e.g. "/blog"
 * @param {RegExp} p.postPattern                 matches a post route, e.g. /^\/blog\/[^/]+$/ (the pager/listing routes are excluded by the caller)
 * @param {Set<string>|string[]} [p.expectedPosts] posts that must be reachable. Default: every built route that matches postPattern
 * @param {Map<string,string>} [p.baseline]      route -> html of a build of the SAME site before the change
 * @param {string} [p.sitemapXml]
 * @param {number} [p.maxPages]
 * @returns {{ ok: boolean, problems: string[], warnings: string[], pages: string[], posts: number }}  ok depends on `problems` only; `warnings` are advisory
 */
export function checkPagination({ built, origin, firstPage, postPattern, expectedPosts = null, baseline = null, sitemapXml = null, maxPages = 500 }) {
  const problems = [], warnings = [];
  const first = normRoute(firstPage);
  if (!built.has(first)) return { ok: false, problems: [`the first listing page ${first} was not built`], warnings, pages: [], posts: 0 };

  // Follow the rel="next" chain from page 1: this finds the pages without assuming any URL scheme.
  const chain = [], facts = new Map();
  for (let route = first; route && !facts.has(route) && chain.length < maxPages;) {
    if (!built.has(route)) { problems.push(`rel="next" points to ${route}, which was not built`); break; }
    chain.push(route);
    const f = describePage(built.get(route), { origin, postPrefix: postPattern });
    facts.set(route, f);
    route = f.next;
  }
  if (chain.length === maxPages) problems.push('the rel="next" chain never ends');

  const isListing = new Set(chain);
  // A numbered page that exists but is not in the chain is a listing page the chain cannot reach (a missing or wrong rel="next" upstream).
  const numbered = new RegExp(`^${first === '/' ? '' : first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/page/\\d+$`);
  const stranded = [...built.keys()].filter((r) => numbered.test(r) && !isListing.has(r));
  if (stranded.length) problems.push(`${stranded.length} numbered page(s) exist but the rel="next" chain never reaches them: ${stranded.slice(0, 5).join(', ')}`);
  const isPost = (r) => postPattern.test(r) && !isListing.has(r);
  const posts = expectedPosts ? new Set([...expectedPosts].map(normRoute)) : new Set([...built.keys()].filter(isPost));

  // 1. every post reachable, exactly once across all pages
  const times = new Map();
  for (const route of chain) for (const p of facts.get(route).posts) if (isPost(p) || posts.has(p)) times.set(p, (times.get(p) || 0) + 1);
  const missing = [...posts].filter((p) => !times.has(p));
  const doubled = [...times].filter(([, n]) => n > 1).map(([p]) => p);
  if (missing.length) problems.push(`${missing.length} post(s) are no longer reachable from the listing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`);
  if (doubled.length) problems.push(`${doubled.length} post(s) appear on more than one listing page: ${doubled.slice(0, 5).join(', ')}`);

  // 2. canonical + prev/next chain
  chain.forEach((route, i) => {
    const f = facts.get(route);
    const want = normRoute(new URL(route, origin).href);
    if (f.canonical !== want) problems.push(`${route}: canonical is ${f.canonical ?? '(missing)'}, expected ${want}`);
    const wantPrev = i === 0 ? null : chain[i - 1];
    if (f.prev !== wantPrev) problems.push(`${route}: rel="prev" is ${f.prev ?? '(none)'}, expected ${wantPrev ?? '(none)'}`);
    // 4. pager links resolve
    for (const h of f.hrefs) {
      if (/\/page\/\d+$|[?&]page=\d+/.test(h) && !built.has(h)) problems.push(`${route}: pager link ${h} has no built page`);
    }
  });

  // 3. unique titles and descriptions
  for (const key of ['title', 'description']) {
    const seen = new Map();
    for (const route of chain) {
      const v = facts.get(route)[key];
      if (!v) { problems.push(`${route}: no ${key}`); continue; }
      if (seen.has(v)) problems.push(`${route}: ${key} duplicates ${seen.get(v)}`);
      else seen.set(v, route);
    }
  }

  // 5. sitemap
  if (sitemapXml) {
    const listed = new Set([...String(sitemapXml).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => normRoute(m[1])));
    // A post missing from the sitemap is a real problem. A numbered LISTING page missing from it is only advisory: Eleventy, for one, leaves
    // pages 2 and up out of its collections (and so out of a sitemap built from them) unless told otherwise, and they are crawlable through the
    // pager either way.
    const absentPosts = [...posts].filter((r) => !listed.has(r));
    const absentPages = chain.filter((r) => !listed.has(r));
    if (absentPosts.length) problems.push(`${absentPosts.length} post(s) are missing from the sitemap: ${absentPosts.slice(0, 5).join(', ')}`);
    if (absentPages.length) warnings.push(`${absentPages.length} listing page(s) are not in the sitemap: ${absentPages.slice(0, 5).join(', ')}`);
  }

  // 6. nothing else changed (asset filename hashes are ignored: appending CSS legitimately renames the bundle)
  if (baseline) {
    // Build noise that differs on every build and says nothing about the page: Next.js's random build id (in a leading comment, in the page's
    // data and in /_next/static/<id>/ paths, in both URL-safe spellings) and its hashed chunk names.
    const noBuildId = (h) => {
      const html = String(h);
      const id = /^(?:<!DOCTYPE html>)?<!--([A-Za-z0-9_-]{16,})-->/i.exec(html)?.[1];
      if (!id) return html;
      const spellings = [...new Set([id, id.replace(/-/g, '_'), id.replace(/_/g, '-')])];
      return spellings.reduce((acc, sp) => acc.split(sp).join('BUILDID'), html);
    };
    const strip = (h) => noBuildId(h).replace(/\/_next\/static\/(chunks|css|media)\/[0-9a-f]{8,}[\w.-]*\.(css|js)/g, '/_next/static/$1/X.$2').replace(/\/_astro\/[A-Za-z0-9_.-]+\.(css|js)/g, '/_astro/X.$1').replace(/(\/[\w./-]*?)\.[0-9a-f]{8,}\.(css|js)\b/g, '$1.X.$2');
    const changed = [...baseline.keys()].filter((r) => built.has(r) && !isListing.has(r) && strip(baseline.get(r)) !== strip(built.get(r)));
    const removed = [...baseline.keys()].filter((r) => !built.has(r));
    if (changed.length) problems.push(`${changed.length} existing page(s) outside the listing changed: ${changed.slice(0, 5).join(', ')}`);
    if (removed.length) problems.push(`${removed.length} existing page(s) disappeared: ${removed.slice(0, 5).join(', ')}`);
  }

  return { ok: problems.length === 0, problems, warnings, pages: chain, posts: posts.size };
}
