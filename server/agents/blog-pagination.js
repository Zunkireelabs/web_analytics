import { getSiteById } from '../store/read.js';
import { listPageInventory } from '../store/page-inventory.js';
import { analyzePageUrl } from './lib/page-content.js';
import { siteOriginFor } from './lib/site-domain.js';
import { makeFinding } from './lib/findings.js';
import { effortForGenerator } from './lib/page-content.js';
import { detectListingRoots, detectChildListings, crawlListing, pathOf } from './lib/blog-listing.js';
import { getFileContent, getRepoTree, defaultBranchName } from '../github/client.js';
import { detectTechnology } from '../discovery/detect-technology.js';
import { recipeSupported } from '../generators/lib/pagination/recipes.js';

// Is every blog post of this site reachable from its blog listing, and is that listing a sensible length? Works on ANY stack: it reads the
// site's own sitemap paths (the page inventory) and the hrefs on the live listing pages, never its source code.
//
//   not-linked   Posts the site publishes (they are in the sitemap) that no page of the listing links to. A crawler follows links, so such a
//                post can only be found through the sitemap. Typical causes: a "load more" button that fetches posts with JavaScript, a listing
//                that stops at the first N posts, or a pagination that was removed.
//   too-long     A single listing page that links to more posts than a visitor or a crawler comfortably takes in (default 30) and has no
//                pagination at all. SuperRank's own blog was the live example: 101 posts, 4,700 words and 176 links on one page.
//
// A listing that is already paginated (any URL scheme), or whose pagination works with JavaScript off, raises neither. Both findings are
// informational unless a recipe exists for the site's framework (see recipeSupported): fixing a listing changes a template, so a person
// reviews it either way.

export const meta = {
  id: 'blog-pagination',
  name: 'Blog Pagination Agent',
  description: 'Checks that every blog post is reachable from the blog listing without JavaScript, and flags a listing that has grown too long for one page.',
  category: 'technical',
  requiresCapabilities: ['public-web'],
  version: 1,
};

export const LONG_LISTING_POSTS = 30;
const MAX_LISTING_PAGES = 60;

const postPath = (root) => new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^/]+/$`);

/**
 * Pure: assess one listing root. `fetchHrefs(path)` returns the hrefs on a listing page, or null if it could not be read.
 * @returns {Promise<{ root, status, listedPosts, publishedPosts, firstPagePosts, pages, paginated, notLinked, tooLong, unreadable, truncated }>}
 */
export const MAX_LIVE_PROBES = 30;

export async function assessListing({ root, inventoryPaths, fetchHrefs, isLive = async () => true, longListing = LONG_LISTING_POSTS, childListings = new Set() }) {
  const isPost = postPath(root);
  const published = inventoryPaths.filter((p) => isPost.test(p) && !childListings.has(p) && !/\/page\/$/.test(p));
  const crawl = await crawlListing([root], fetchHrefs, { childListings, maxPages: MAX_LISTING_PAGES });
  if (crawl.unreadable.includes(root)) return { root, status: 'unreadable', listedPosts: 0, publishedPosts: published.length, pages: crawl.pages.length };

  const paginated = crawl.pages.some((p) => /\/page\/\d+\/?$|[?&]page=\d+/.test(p));
  const firstPagePosts = [...crawl.posts].filter(([, on]) => on.has(root)).length;
  // A gap is only reported when the whole listing was read: a page that could not be fetched, or a crawl cut short, proves nothing.
  const complete = crawl.unreadable.length === 0 && !crawl.truncated;
  const candidates = complete ? published.filter((p) => !crawl.posts.has(p)) : [];
  // An inventory entry can be stale (a post taken down, a page reverted): only a post that is really live and not redirected counts as
  // "not linked". At most MAX_LIVE_PROBES are probed; the rest are reported as unverified, never assumed.
  const probed = candidates.slice(0, MAX_LIVE_PROBES);
  const live = [];
  for (const p of probed) if (await isLive(p)) live.push(p);
  return {
    root, status: 'ok', listedPosts: crawl.posts.size, publishedPosts: published.length, firstPagePosts, pages: crawl.pages.length, paginated,
    notLinked: live, notLinkedUnverified: candidates.length - probed.length, deadInInventory: probed.length - live.length,
    tooLong: !paginated && firstPagePosts > longListing, unreadable: crawl.unreadable, truncated: crawl.truncated,
  };
}

export function buildFindings(assessments, { origin, recipeSupported = () => false, framework = null, urlFor = (root) => `${origin}${root}` } = {}) {
  const findings = [];
  for (const a of assessments) {
    if (a.status !== 'ok') continue;
    const listingUrl = urlFor(a.root);
    if (a.notLinked.length) {
      findings.push(makeFinding({
        id: `blog-pagination:not-linked:${a.root}`,
        evidence: { listing: listingUrl, publishedPosts: a.publishedPosts, linkedFromListing: a.listedPosts, notLinked: a.notLinked.slice(0, 50), notLinkedCount: a.notLinked.length, notLinkedUnverified: a.notLinkedUnverified, listingPagesRead: a.pages },
        whyItMatters: `${a.notLinked.length} live post${a.notLinked.length === 1 ? '' : 's'} (of ${a.publishedPosts} on ${listingUrl}) ${a.notLinked.length === 1 ? 'is' : 'are'} in the site's pages but no page of the blog listing links to ${a.notLinked.length === 1 ? 'it' : 'them'} (${a.pages} listing page${a.pages === 1 ? '' : 's'} read). A crawler follows links, so these posts can only be found through the sitemap. Common causes: a "load more" button that fetches posts with JavaScript, or a listing that stops after the first posts.`,
        priority: a.notLinked.length >= 10 ? 'high' : 'medium',
        recommendedAction: null,
        expectedImpact: { label: a.notLinked.length >= 10 ? 'High' : 'Medium', basis: 'computed', value: a.notLinked.length },
      }));
    }
    if (a.tooLong) {
      const supported = recipeSupported(framework);
      findings.push(makeFinding({
        id: `blog-pagination:too-long:${a.root}`,
        evidence: { listing: listingUrl, postsOnOnePage: a.firstPagePosts, publishedPosts: a.publishedPosts, paginated: false, framework },
        whyItMatters: `${listingUrl} lists ${a.firstPagePosts} posts on a single page and links to no further pages (no /page/N or ?page=N links in its HTML; a pager that only works with JavaScript is invisible to crawlers). Every new post makes the page heavier, and a very long page spreads its links thin. Splitting it into numbered pages (for example 12 posts each) keeps every post one click from a short list.`,
        priority: 'medium',
        recommendedAction: supported ? { label: 'Paginate the blog listing', generatorId: 'blog-pagination', params: { listing: listingUrl }, effort: effortForGenerator('blog-pagination') } : null,
        expectedImpact: { label: 'Medium', basis: 'estimate', value: null },
      }));
    }
  }
  return findings;
}

// The site's framework, read from its own repository (config files and dependencies): `tech_stack` is empty on every site today. null when
// there is no repository, it cannot be read, or the answer is ambiguous or low-confidence: no recipe is offered on a guess.
export async function frameworkForSite(site, { readTree = getRepoTree, readFile = getFileContent, detect = detectTechnology } = {}) {
  // `tech_stack` is free text ("nextjs, tailwind"): a framework with a recipe named in it wins; a single plain word is taken as it is; a list
  // that names no framework we can paginate is read from the repository instead.
  const ALIASES = { next: 'nextjs', 'next.js': 'nextjs', '11ty': 'eleventy' };
  const named = String(site.tech_stack || '').toLowerCase().split(/[,;/|\s]+/).filter(Boolean).map((t) => ALIASES[t] || t);
  const known = named.find((t) => recipeSupported(t));
  if (known) return known;
  if (named.length === 1) return named[0];
  if (!site.repo_owner || !site.repo_name) return null;
  try {
    const ref = defaultBranchName(site);
    const tree = await readTree(site, ref);
    const pkg = tree.files.includes('package.json') ? (await readFile(site, 'package.json', ref))?.content : null;
    const fw = detect({ files: tree.files, packageJsonRaw: pkg }).framework;
    return fw?.id && !fw.ambiguous && fw.confidence?.level !== 'low' ? fw.id : null;
  } catch { return null; }
}

export async function run({ siteId, pageCache }) {
  const site = await getSiteById(siteId);
  const origin = site ? siteOriginFor(site) : null;
  if (!origin) return { meta, status: 'insufficient-data', facts: null, narrative: null, message: 'This site has no domain to check.', generatedAt: new Date().toISOString() };

  const inventory = await listPageInventory(siteId, { limit: 100000 });
  const inventoryPaths = [...new Set(inventory.map((r) => pathOf(r.page, origin)).filter(Boolean))];
  const roots = detectListingRoots(inventoryPaths).slice(0, 3);
  if (!roots.length) return { meta, status: 'ok', facts: { listings: [], findings: [] }, narrative: null, message: 'No blog-like listing found in this site\'s pages.', generatedAt: new Date().toISOString() };

  // One fetch per listing page, through the run's shared cache when there is one (same pattern as the technical SEO agent).
  const fetchPage = pageCache || analyzePageUrl;
  // Paths are compared with a trailing slash, but a site chooses ONE form for its URLs: SuperRank serves /blog and answers /blog/ with a 403.
  // So a page is tried as given and then in the other form, and the first that reads wins.
  const fetchEither = async (path) => {
    const forms = path.length > 1 && path.endsWith('/') ? [path, path.slice(0, -1)] : [path, `${path}/`];
    for (const form of forms) {
      const res = await fetchPage(`${origin}${form}`).catch(() => null);
      if (res?.ok) return res;
    }
    return null;
  };
  const fetchHrefs = async (path) => {
    const res = await fetchEither(path);
    return res ? (res.analysis?.internalLinks || []).map((h) => pathOf(h, origin)).filter(Boolean) : null;
  };
  const isLive = async (path) => {
    const res = await fetchEither(path);
    return Boolean(res && !res.analysis?.wasRedirected);
  };
  const childListings = detectChildListings(inventoryPaths, roots);
  const assessments = [];
  for (const root of roots) assessments.push(await assessListing({ root, inventoryPaths, fetchHrefs, isLive, childListings }));

  // Quote each listing the way the site itself writes its URL (the inventory's own form), not with a slash the site may reject.
  const written = new Map(inventory.map((r) => [pathOf(r.page, origin), r.page]));
  // The repository is only read when there is a too-long listing to offer a fix for.
  const framework = assessments.some((a) => a.tooLong) ? await frameworkForSite(site) : null;
  const findings = buildFindings(assessments, { origin, framework, recipeSupported, urlFor: (root) => written.get(root) || `${origin}${root}` });
  return { meta, status: 'ok', facts: { listings: assessments.map(({ notLinked, ...a }) => ({ ...a, notLinkedCount: notLinked?.length || 0 })), findings }, narrative: null, generatedAt: new Date().toISOString() };
}
