import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectListingRoots, detectChildListings, classifyListingHrefs, crawlListing } from './blog-listing.js';

describe('crawlListing: walks a listing across every page, on any URL scheme', () => {
  // A fake site: /blog (page 1) -> /blog/page/2 -> /blog/page/3, plus a category /blog/articles with its own page 2.
  const site = {
    '/blog/': ['/blog/a/', '/blog/b/', '/blog/page/2/', '/blog/articles/', '/blog/'],
    '/blog/page/2/': ['/blog/c/', '/blog/d/', '/blog/page/3/'],
    '/blog/page/3/': ['/blog/e/'],
    '/blog/articles/': ['/blog/a/', '/blog/f/', '/blog/articles/page/2/'],
    '/blog/articles/page/2/': ['/blog/g/'],
  };
  const children = new Set(['/blog/articles/']);
  const fetchHrefs = async (p) => site[p] ?? null;

  test('finds every post once per page it is listed on, following pagination and category listings', async () => {
    const r = await crawlListing(['/blog/'], fetchHrefs, { childListings: children });
    assert.deepEqual([...r.posts.keys()].sort(), ['/blog/a/', '/blog/b/', '/blog/c/', '/blog/d/', '/blog/e/', '/blog/f/', '/blog/g/']);
    assert.deepEqual([...r.posts.get('/blog/a/')].sort(), ['/blog/', '/blog/articles/'], 'a post in two listings is seen on both');
    assert.ok(r.pages.includes('/blog/page/3/') && r.pages.includes('/blog/articles/page/2/'));
    assert.deepEqual(r.unreadable, []);
    assert.equal(r.truncated, false);
  });
  test('an unreadable page is reported, never guessed at', async () => {
    const r = await crawlListing(['/blog/'], async (p) => (p === '/blog/page/3/' ? null : site[p] ?? null), { childListings: children });
    assert.deepEqual(r.unreadable, ['/blog/page/3/']);
    assert.ok(!r.posts.has('/blog/e/'));
  });
  test('a page cap stops a runaway listing and says so', async () => {
    const endless = async (p) => { const n = Number(p.match(/(\d+)\/?$/)?.[1] || 1); return [`/blog/p${n}/`, `/blog/page/${n + 1}/`]; };
    const r = await crawlListing(['/blog/'], endless, { maxPages: 5 });
    assert.equal(r.pages.length, 5);
    assert.equal(r.truncated, true);
  });
});

describe('the shared listing helpers', () => {
  test('roots, child listings and href classification (moved from the verification script, same behaviour)', () => {
    const paths = [...Array.from({ length: 10 }, (_, i) => `/blog/p${i}/`), ...Array.from({ length: 4 }, (_, i) => `/blog/articles/x${i}/`)];
    assert.deepEqual(detectListingRoots(paths), ['/blog/']);
    assert.deepEqual([...detectChildListings(paths, ['/blog/'])], ['/blog/articles/']);
    const r = classifyListingHrefs(['/blog/one/', '/blog/page/2/', '/about/', '/blog/'], '/blog/');
    assert.deepEqual(r.posts, ['/blog/one/']);
    assert.deepEqual(r.listings, ['/blog/page/2/']);
  });
});
