import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';

// Framework-agnostic "did this change break the website?" check. It knows nothing about Next.js, Eleventy, React or any client: it
// compares two BUILT output folders (the site built from the base branch, and the same site built with the proposed change) and
// reports violations. Any site that builds to a folder of HTML — static export, SSG, a pre-rendered SPA — can use it; a site whose
// build produces no HTML folder simply cannot be validated and the caller must treat that as "do not ship".
//
// Rules (each is a violation code a caller can block on):
//   page-removed          a page that existed before is gone (and was not meant to be removed)
//   unintended-change     a page nobody meant to change renders differently (design, content, links, anything visible)
//   metadata-regression   an intentionally changed page lost its title / description / canonical / JSON-LD / h1
//   bad-jsonld            a JSON-LD block does not parse
//   broken-image          a changed or new page references a local image the build does not contain
//   broken-link           a changed or new page links to an internal path the build does not contain
//   new-page-incomplete   a new page lacks a title, description, canonical or exactly one h1
//   canonical-mismatch    a new/changed page's canonical is not its own URL on the site's origin
//   duplicate-page        a new page's rendered content is identical to another page's (duplicate content / slug clash)

export const RIPPLE_MAX_CHARS = 4000;
const SKIP_DIRS = new Set(['_next', 'node_modules', '.git']);

export function urlFromFile(rel) {
  const p = rel.split(sep).join('/');
  if (p === 'index.html') return '/';
  if (p.endsWith('/index.html')) return `/${p.slice(0, -'/index.html'.length)}`;
  return `/${p.replace(/\.html$/, '')}`;
}

export function collectPages(dir) {
  const pages = new Map();
  const assets = new Set();
  (function walk(d) {
    for (const name of readdirSync(d)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const rel = relative(dir, full);
      if (extname(name) === '.html') pages.set(urlFromFile(rel), full);
      assets.add(`/${rel.split(sep).join('/')}`);
    }
  })(dir);
  return { pages, assets };
}

const first = (re, s) => { const m = re.exec(s); return m ? m[1].trim() : null; };
const attr = (tag, name) => first(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'), tag);

export function extractFacts(html) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const metaContent = (key, val) => { const t = metas.find((x) => new RegExp(`${key}\\s*=\\s*["']${val}["']`, 'i').test(x)); return t ? attr(t, 'content') : null; };
  const canonicalTag = (html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i) || [])[0];
  const jsonld = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const types = []; let invalidJsonLd = 0;
  for (const raw of jsonld) {
    try { const v = JSON.parse(raw); for (const n of [].concat(v['@graph'] || v)) if (n?.['@type']) types.push(...[].concat(n['@type'])); } catch { invalidJsonLd++; }
  }
  return {
    title: first(/<title[^>]*>([\s\S]*?)<\/title>/i, html),
    description: metaContent('name', 'description'),
    robots: metaContent('name', 'robots'),
    ogTitle: metaContent('property', 'og:title'),
    ogImage: metaContent('property', 'og:image'),
    canonical: canonicalTag ? attr(canonicalTag, 'href') : null,
    h1: (html.match(/<h1[\s>]/gi) || []).length,
    jsonldTypes: types.sort(), invalidJsonLd,
    links: [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)].map((m) => m[1]),
    images: [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
  };
}

// Build output differs between two builds of IDENTICAL source in hashes, ids and framework payload scripts. Only what a visitor can
// see or a crawler reads is compared: markup with scripts/styles/comments/hash-like tokens removed and whitespace collapsed.
export function normalizeForCompare(html, { dropLinksTo = [], origin = '' } = {}) {
  let h = html;
  // A new page legitimately appears as a card/link on listing and related-posts pages. Those anchors (and only those) are removed from
  // both sides before comparing, so "a link to the new post appeared" is not an unintended change but anything ELSE that moved is.
  for (const u of dropLinksTo) {
    const esc = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    h = h.replace(new RegExp(`<a\\b[^>]*\\bhref\\s*=\\s*["'](?:${(origin || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?${esc}/?["'][^>]*>[\\s\\S]*?</a>`, 'gi'), '');
  }
  return h
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(\/_next\/[^"' )]*?)[-.][0-9a-f]{8,}(\.[a-z0-9]+)/gi, '$1$2')
    .replace(/(\?|&)(v|dpl|ver)=[^"'&\s]+/gi, '')
    .replace(/\b(id|for|aria-controls|aria-labelledby)="(:[\w:]+:|_R_[\w]+_|«[^»]*»)"/g, '$1="#"')
    .replace(/\s+/g, ' ')
    .trim();
}

const hostPath = (href, origin) => {
  if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) return null;
  try {
    const u = new URL(href, `${origin}/`);
    if (u.origin !== new URL(origin).origin) return null; // external — not this check's business
    return u.pathname.replace(/\/+$/, '') || '/';
  } catch { return null; }
};

export function compareBuilds({ baseDir, candDir, origin, intendedUrls = [], newUrls = [], removedUrls = [] }) {
  const violations = [];
  const base = collectPages(baseDir);
  const cand = collectPages(candDir);
  const intended = new Set([...intendedUrls, ...newUrls]);
  const norm = (u) => (u.length > 1 ? u.replace(/\/+$/, '') : u);
  const intendedN = new Set([...intended].map(norm));
  const resolves = (path) => cand.pages.has(path) || cand.assets.has(path) || cand.assets.has(`${path}.html`) || cand.assets.has(`${path}/index.html`);

  for (const [url, file] of base.pages) {
    if (removedUrls.map(norm).includes(norm(url))) continue;
    const c = cand.pages.get(url);
    if (!c) { violations.push({ code: 'page-removed', url }); continue; }
    if (intendedN.has(norm(url))) continue;
    const nopt = { dropLinksTo: newUrls, origin };
    if (normalizeForCompare(readFileSync(file, 'utf8'), nopt) !== normalizeForCompare(readFileSync(c, 'utf8'), nopt)) {
      // A page that now links to the NEW page and differs only around it is a listing ("latest posts", category grid, related posts): the new
      // card pushed an older one out. That is expected, never blocks, but is always reported so a person can see which pages moved.
      const rawCand = readFileSync(c, 'utf8');
      const showsNew = newUrls.some((n) => new RegExp(`href\\s*=\\s*["'](?:${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?${norm(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?["']`, 'i').test(rawCand));
      // Heuristic limit: one card is roughly 1-2 KB of markup. A bigger difference than RIPPLE_MAX_CHARS is more than "a card moved", so it blocks.
      const nb = normalizeForCompare(readFileSync(file, 'utf8'), nopt); const nc = normalizeForCompare(rawCand, nopt);
      let pre = 0; while (pre < nb.length && pre < nc.length && nb[pre] === nc[pre]) pre++;
      let suf = 0; while (suf < nb.length - pre && suf < nc.length - pre && nb[nb.length - 1 - suf] === nc[nc.length - 1 - suf]) suf++;
      const diffChars = Math.max(nb.length - pre - suf, nc.length - pre - suf);
      violations.push(showsNew && diffChars <= RIPPLE_MAX_CHARS
        ? { code: 'listing-ripple', url, severity: 'info', detail: `Listing page now includes the new post (an older card moved out); changed block ${diffChars} chars.` }
        : { code: 'unintended-change', url, detail: 'Rendered output of a page this change was not meant to touch differs from the base build.' });
    }
  }

  const bodyHashes = new Map();
  for (const [url, file] of cand.pages) {
    if (!base.pages.has(url) || !intendedN.has(norm(url))) {
      if (!newUrls.map(norm).includes(norm(url))) continue;
    }
    const html = readFileSync(file, 'utf8');
    const f = extractFacts(html);
    const isNew = !base.pages.has(url);
    if (f.invalidJsonLd) violations.push({ code: 'bad-jsonld', url, detail: `${f.invalidJsonLd} JSON-LD block(s) do not parse.` });
    for (const src of f.images) {
      const p = hostPath(src, origin);
      if (p && !resolves(p) && !p.startsWith('/_next/image')) violations.push({ code: 'broken-image', url, detail: p });
    }
    for (const href of f.links) {
      const p = hostPath(href, origin);
      if (p && !resolves(p)) violations.push({ code: 'broken-link', url, detail: p });
    }
    if (f.canonical && hostPath(f.canonical, origin) !== norm(url)) violations.push({ code: 'canonical-mismatch', url, detail: f.canonical });
    if (isNew) {
      for (const [k, v] of [['title', f.title], ['description', f.description], ['canonical', f.canonical]]) if (!v) violations.push({ code: 'new-page-incomplete', url, detail: `missing ${k}` });
      if (f.h1 !== 1) violations.push({ code: 'new-page-incomplete', url, detail: `expected exactly one h1, found ${f.h1}` });
      const h = normalizeForCompare(html);
      for (const [u2, h2] of bodyHashes) if (h2 === h) violations.push({ code: 'duplicate-page', url, detail: `identical to ${u2}` });
      bodyHashes.set(url, h);
    } else {
      const bf = extractFacts(readFileSync(base.pages.get(url), 'utf8'));
      for (const k of ['title', 'description', 'canonical']) if (bf[k] && !f[k]) violations.push({ code: 'metadata-regression', url, detail: `lost ${k}` });
      for (const t of bf.jsonldTypes) if (!f.jsonldTypes.includes(t)) violations.push({ code: 'metadata-regression', url, detail: `lost JSON-LD ${t}` });
      if (bf.h1 >= 1 && f.h1 === 0) violations.push({ code: 'metadata-regression', url, detail: 'lost its h1' });
    }
  }
  for (const u of newUrls) if (!cand.pages.has(norm(u))) violations.push({ code: 'new-page-incomplete', url: u, detail: 'expected new page is not in the build output' });

  return { ok: violations.every((v) => v.severity === 'info'), violations, stats: { basePages: base.pages.size, candPages: cand.pages.size, intended: intended.size } };
}

export function hasBuildOutput(dir) { return existsSync(dir) && collectPages(dir).pages.size > 0; }
