// How a blog listing is found and read, on any stack: from a site's own sitemap paths and the hrefs on its listing pages, never from source
// code. Shared by the blog-pagination agent and by scripts/verify-blog-coverage.js so both read a listing exactly the same way.

const BLOGLIKE = /blog|news|articles|insights|journal|resources|posts/i;
const pathOf = (u, origin) => { try { return new URL(u, origin).pathname.replace(/\/?$/, '/'); } catch { return null; } };
export { pathOf };

// Listing roots from sitemap/inventory paths: "/blog/" when many URLs look like /blog/<slug>/. A language prefix is kept (/nl/blog/).
export function detectListingRoots(sitemapPaths, { minChildren = 8 } = {}) {
  const counts = new Map();
  for (const p of sitemapPaths) {
    const m = p.match(/^(\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?[^/]+\/)[^/]+\/$/);
    if (m && !/\/page\/$/.test(m[1])) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= minChildren).map(([root]) => root).filter((r) => BLOGLIKE.test(r));
}

// Child paths that are listings themselves: /blog/articles/ is one when the sitemap has URLs underneath it (/blog/articles/<x>/).
export function detectChildListings(sitemapPaths, roots, { minChildren = 3 } = {}) {
  const counts = new Map();
  for (const p of sitemapPaths) for (const root of roots) {
    if (!p.startsWith(root)) continue;
    const segs = p.slice(root.length).replace(/\/$/, '').split('/');
    if (segs.length >= 2 && segs[0] !== 'page') counts.set(`${root}${segs[0]}/`, (counts.get(`${root}${segs[0]}/`) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= minChildren).map(([c]) => c));
}

// What a list of hrefs from one listing page says: more listing pages to visit (pagination, child listings) and the posts it lists.
export function classifyListingHrefs(hrefs, root, { childListings = new Set() } = {}) {
  const posts = new Set(), listings = new Set();
  for (const raw of hrefs) {
    const h = String(raw).split('#')[0].split('?')[0];
    if (!h.startsWith(root) || h === root) continue;
    const segs = h.slice(root.length).replace(/\/$/, '').split('/');
    if (segs[0] === 'page' && /^\d+$/.test(segs[1] || '')) { listings.add(h); continue; }
    if (segs.length >= 3 && segs[1] === 'page' && /^\d+$/.test(segs[2])) { listings.add(h); childListings.add(`${root}${segs[0]}/`); continue; }
    if (segs.length === 1) { if (childListings.has(`${root}${segs[0]}/`)) listings.add(h); else posts.add(h.endsWith('/') ? h : `${h}/`); }
  }
  return { posts: [...posts], listings: [...listings] };
}
export const classifyListingLinks = (html, root, opts) => classifyListingHrefs([...String(html).matchAll(/href="([^"#?]+)"/g)].map((m) => m[1]), root, opts);

/**
 * Walk a listing and every page of it. `fetchHrefs(path)` returns the hrefs (paths) found on that page, or null when it could not be read.
 * Returns { posts: Map<postPath, Set<listingPath>>, pages: string[], unreadable: string[], truncated: boolean }.
 */
export async function crawlListing(roots, fetchHrefs, { childListings = new Set(), maxPages = 60 } = {}) {
  const seen = new Set(), queue = [...roots], posts = new Map(), unreadable = [], children = new Set(childListings);
  while (queue.length && seen.size < maxPages) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const root = roots.find((r) => path.startsWith(r)) || roots[0];
    const hrefs = await fetchHrefs(path);
    if (hrefs === null) { unreadable.push(path); continue; }
    const out = classifyListingHrefs(hrefs, root, { childListings: children });
    for (const l of out.listings) if (!seen.has(l)) queue.push(l);
    for (const c of children) if (!seen.has(c)) queue.push(c);
    for (const p of out.posts) { if (!posts.has(p)) posts.set(p, new Set()); posts.get(p).add(path); }
  }
  return { posts, pages: [...seen], unreadable, truncated: queue.length > 0 };
}
