import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectListingRoots, classifyListingLinks, detectChildListings } from './verify-blog-coverage.js';

describe('detectListingRoots', () => {
  test('finds a blog root from many /blog/<slug>/ sitemap URLs, with language prefixes kept apart', () => {
    const paths = [
      ...Array.from({ length: 10 }, (_, i) => `/blog/post-${i}/`),
      ...Array.from({ length: 9 }, (_, i) => `/nl/blog/bericht-${i}/`),
      '/about/', '/services/seo/', ...Array.from({ length: 3 }, (_, i) => `/team/p${i}/`),
    ];
    assert.deepEqual(detectListingRoots(paths).sort(), ['/blog/', '/nl/blog/']);
  });
  test('a path with few children, or not blog-like, is not a listing', () => {
    assert.deepEqual(detectListingRoots(['/blog/a/', '/blog/b/']), []);
    assert.deepEqual(detectListingRoots(Array.from({ length: 20 }, (_, i) => `/team/p${i}/`)), []);
  });
});

describe('classifyListingLinks', () => {
  const html = (links) => links.map((l) => `<a href="${l}">x</a>`).join('');
  test('separates posts from pagination, and never counts /page/N/ as a post', () => {
    const r = classifyListingLinks(html(['/blog/a-post/', '/blog/page/2/', '/blog/page/10/', '/about/', '/blog/']), '/blog/');
    assert.deepEqual(r.posts, ['/blog/a-post/']);
    assert.deepEqual(r.listings.sort(), ['/blog/page/10/', '/blog/page/2/']);
  });
  test('a child that has its own pagination is a listing, and from then on its links are not posts', () => {
    const child = new Set();
    const first = classifyListingLinks(html(['/blog/articles/page/2/', '/blog/real-post/']), '/blog/', { childListings: child });
    assert.ok(child.has('/blog/articles/'));
    assert.deepEqual(first.posts, ['/blog/real-post/']);
    const second = classifyListingLinks(html(['/blog/articles/', '/blog/another/']), '/blog/', { childListings: child });
    assert.deepEqual(second.posts, ['/blog/another/']);
    assert.deepEqual(second.listings, ['/blog/articles/']);
  });
});

describe('detectChildListings', () => {
  test('a path with posts underneath it in the sitemap is a listing, a single post is not', () => {
    const paths = ['/blog/articles/a/', '/blog/articles/b/', '/blog/articles/c/', '/blog/one-post/', '/blog/page/2/'];
    assert.deepEqual([...detectChildListings(paths, ['/blog/'])], ['/blog/articles/']);
  });
});
