import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessListing, buildFindings, frameworkForSite, LONG_LISTING_POSTS, MAX_LIVE_PROBES } from './blog-pagination.js';
import { recipeSupported } from '../generators/lib/pagination/recipes.js';

const slugs = (n, prefix = 'post') => Array.from({ length: n }, (_, i) => `/blog/${prefix}-${i + 1}/`);
const ORIGIN = 'https://example.com';
// A site: pages is a map listing-path -> hrefs. Anything absent is unreadable.
const reader = (pages) => async (p) => pages[p] ?? null;

describe('assessListing', () => {
  test('SuperRank case: 101 posts on one page and no pagination is too long', async () => {
    const all = slugs(101);
    const a = await assessListing({ root: '/blog/', inventoryPaths: all, fetchHrefs: reader({ '/blog/': ['/about/', ...all] }) });
    assert.equal(a.status, 'ok');
    assert.equal(a.firstPagePosts, 101);
    assert.equal(a.paginated, false);
    assert.equal(a.tooLong, true);
    assert.deepEqual(a.notLinked, [], 'every post is linked, so nothing is unreachable');
  });

  test('a correctly paginated blog raises nothing, even with 100+ posts', async () => {
    const all = slugs(36);
    const pages = { '/blog/': [...all.slice(0, 12), '/blog/page/2/'], '/blog/page/2/': [...all.slice(12, 24), '/blog/page/3/'], '/blog/page/3/': all.slice(24) };
    const a = await assessListing({ root: '/blog/', inventoryPaths: all, fetchHrefs: reader(pages) });
    assert.equal(a.paginated, true);
    assert.equal(a.tooLong, false);
    assert.deepEqual(a.notLinked, []);
    assert.equal(a.pages, 3);
  });

  test('a small blog on one page is fine', async () => {
    const all = slugs(LONG_LISTING_POSTS);
    const a = await assessListing({ root: '/blog/', inventoryPaths: all, fetchHrefs: reader({ '/blog/': all }) });
    assert.equal(a.tooLong, false, 'exactly the limit is not over it');
    assert.equal(slugs(LONG_LISTING_POSTS + 1).length, 31);
    const b = await assessListing({ root: '/blog/', inventoryPaths: slugs(31), fetchHrefs: reader({ '/blog/': slugs(31) }) });
    assert.equal(b.tooLong, true);
  });

  test('"load more" case: posts that exist but the listing HTML never links to are found', async () => {
    const all = slugs(40);
    const a = await assessListing({ root: '/blog/', inventoryPaths: all, fetchHrefs: reader({ '/blog/': all.slice(0, 12) }) });
    assert.equal(a.notLinked.length, 28);
    assert.equal(a.tooLong, false);
  });

  test('mobilise case: stale inventory entries that are no longer live are not reported as "not linked"', async () => {
    const all = slugs(35);
    const dead = new Set(all.slice(10));
    const a = await assessListing({ root: '/blog/', inventoryPaths: all, fetchHrefs: reader({ '/blog/': all.slice(0, 10) }), isLive: async (p) => !dead.has(p) });
    assert.deepEqual(a.notLinked, []);
    assert.equal(a.deadInInventory, 25);
  });

  test('a live post the listing misses is reported even when the inventory also holds dead ones', async () => {
    const all = slugs(12);
    const a = await assessListing({ root: '/blog/', inventoryPaths: all, fetchHrefs: reader({ '/blog/': all.slice(0, 10) }), isLive: async (p) => p !== all[11] });
    assert.deepEqual(a.notLinked, [all[10]]);
    assert.equal(a.deadInInventory, 1);
  });

  test('an unreadable listing page proves nothing: no gap is claimed', async () => {
    const all = slugs(40);
    const pages = { '/blog/': [...all.slice(0, 12), '/blog/page/2/'] }; // page 2 cannot be read
    const a = await assessListing({ root: '/blog/', inventoryPaths: all, fetchHrefs: reader(pages) });
    assert.deepEqual(a.notLinked, []);
    assert.deepEqual(a.unreadable, ['/blog/page/2/']);
  });

  test('a listing that cannot be read at all is reported as such, not as an empty blog', async () => {
    const a = await assessListing({ root: '/blog/', inventoryPaths: slugs(20), fetchHrefs: reader({}) });
    assert.equal(a.status, 'unreadable');
  });

  test('at most MAX_LIVE_PROBES posts are probed; the rest are reported as unverified, never assumed', async () => {
    const all = slugs(100);
    let probes = 0;
    const a = await assessListing({ root: '/blog/', inventoryPaths: all, fetchHrefs: reader({ '/blog/': all.slice(0, 10) }), isLive: async () => { probes++; return true; } });
    assert.equal(probes, MAX_LIVE_PROBES);
    assert.equal(a.notLinked.length, MAX_LIVE_PROBES);
    assert.equal(a.notLinkedUnverified, 90 - MAX_LIVE_PROBES);
  });

  test('a category listing under the blog is followed and its posts count as linked', async () => {
    const all = [...slugs(10), ...Array.from({ length: 4 }, (_, i) => `/blog/articles/art-${i}/`)];
    const pages = { '/blog/': [...slugs(10), '/blog/articles/'], '/blog/articles/': Array.from({ length: 4 }, (_, i) => `/blog/art-${i}/`) };
    const a = await assessListing({ root: '/blog/', inventoryPaths: all, fetchHrefs: reader(pages), childListings: new Set(['/blog/articles/']) });
    assert.equal(a.status, 'ok');
    assert.deepEqual(a.unreadable, []);
  });
});

describe('buildFindings', () => {
  const base = { status: 'ok', root: '/blog/', publishedPosts: 101, listedPosts: 101, firstPagePosts: 101, pages: 1, paginated: false, notLinked: [], notLinkedUnverified: 0, tooLong: false };

  test('too-long: one finding, informational until a recipe exists for the framework', () => {
    const [f] = buildFindings([{ ...base, tooLong: true }], { origin: ORIGIN, framework: 'astro' });
    assert.match(f.id, /^blog-pagination:too-long:\/blog\//);
    assert.equal(f.recommendedAction, null);
    assert.match(f.whyItMatters, /101 posts on a single page/);
    assert.match(f.whyItMatters, /invisible to crawlers/);
  });
  test('a listing is quoted the way the site writes its URL (SuperRank has no trailing slash)', () => {
    const [f] = buildFindings([{ ...base, tooLong: true }], { origin: ORIGIN, urlFor: () => 'https://example.com/blog' });
    assert.equal(f.evidence.listing, 'https://example.com/blog');
    assert.match(f.whyItMatters, /^https:\/\/example\.com\/blog lists/);
  });
  test('too-long: carries the fix only when a recipe supports the framework', () => {
    const [f] = buildFindings([{ ...base, tooLong: true }], { origin: ORIGIN, framework: 'eleventy', recipeSupported: (fw) => fw === 'eleventy' });
    assert.deepEqual({ ...f.recommendedAction, effort: undefined }, { label: 'Paginate the blog listing', generatorId: 'blog-pagination', params: { listing: 'https://example.com/blog/' }, effort: undefined });
    assert.equal(f.recommendedAction.effort, 'Medium');
  });
  test('not-linked: priority follows how many live posts are missing, and it never carries an automatic fix', () => {
    const few = buildFindings([{ ...base, notLinked: slugs(3) }], { origin: ORIGIN })[0];
    const many = buildFindings([{ ...base, notLinked: slugs(12) }], { origin: ORIGIN })[0];
    assert.equal(few.priority, 'medium');
    assert.equal(many.priority, 'high');
    assert.equal(many.recommendedAction, null);
    assert.equal(many.evidence.notLinkedCount, 12);
  });
  test('a healthy listing, or an unreadable one, produces no findings', () => {
    assert.deepEqual(buildFindings([base, { ...base, status: 'unreadable' }], { origin: ORIGIN }), []);
  });
});

describe('frameworkForSite: read from the repository, never guessed', () => {
  const repoSite = { repo_owner: 'o', repo_name: 'r', repo_default_branch: 'main' };
  const eleventy = { readTree: async () => ({ files: ['package.json', '.eleventy.js'] }), readFile: async () => ({ content: JSON.stringify({ devDependencies: { '@11ty/eleventy': '^3' } }) }) };
  test('detects Eleventy from its config file and dependency', async () => assert.equal(await frameworkForSite(repoSite, eleventy), 'eleventy'));
  test('a configured tech_stack wins without touching GitHub', async () => assert.equal(await frameworkForSite({ ...repoSite, tech_stack: 'Astro' }, { readTree: async () => { throw new Error('must not read'); } }), 'astro'));
  test('no repository, an unreadable one, or an ambiguous answer all give null', async () => {
    assert.equal(await frameworkForSite({}, eleventy), null);
    assert.equal(await frameworkForSite(repoSite, { readTree: async () => { throw new Error('403'); } }), null);
    assert.equal(await frameworkForSite(repoSite, { readTree: async () => ({ files: ['README.md'] }), readFile: async () => null }), null);
  });
  test('free-text tech_stack: the framework with a recipe is picked out; a list with none is read from the repo', async () => {
    assert.equal(await frameworkForSite({ ...repoSite, tech_stack: 'nextjs, tailwind' }, { readTree: async () => { throw new Error('must not read'); } }), 'nextjs');
    assert.equal(await frameworkForSite({ ...repoSite, tech_stack: 'Next.js' }, { readTree: async () => { throw new Error('must not read'); } }), 'nextjs');
    assert.equal(await frameworkForSite({ ...repoSite, tech_stack: 'tailwind, alpine' }, eleventy), 'eleventy');
  });
  test('end to end: an Eleventy or Astro site with a too-long listing is offered the generator; a stack with no recipe is only told', async () => {
    const tooLong = [{ status: 'ok', root: '/blog/', publishedPosts: 60, listedPosts: 60, firstPagePosts: 60, pages: 1, paginated: false, notLinked: [], notLinkedUnverified: 0, tooLong: true }];
    const fwEleventy = await frameworkForSite(repoSite, eleventy);
    assert.equal(buildFindings(tooLong, { origin: ORIGIN, framework: fwEleventy, recipeSupported })[0].recommendedAction?.generatorId, 'blog-pagination');
    assert.equal(buildFindings(tooLong, { origin: ORIGIN, framework: 'astro', recipeSupported })[0].recommendedAction?.generatorId, 'blog-pagination');
    assert.equal(buildFindings(tooLong, { origin: ORIGIN, framework: 'hugo', recipeSupported })[0].recommendedAction, null);
  });
});
