import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkPagination, normRoute, describePage } from './pagination-acceptance.js';

const ORIGIN = 'https://example.com';
const POST = /^\/blog\/[^/]+$/;
const url = (n) => (n === 1 ? '/blog' : `/blog/page/${n}`);

// A small, correct paginated blog: `perPage` posts a page, `total` posts.
function site({ total = 7, perPage = 3 } = {}) {
  const pages = new Map(); const posts = Array.from({ length: total }, (_, i) => `/blog/post-${i + 1}`);
  const count = Math.ceil(total / perPage);
  for (let n = 1; n <= count; n++) {
    const mine = posts.slice((n - 1) * perPage, n * perPage);
    pages.set(url(n), `<html><head><title>Blog page ${n}</title><meta name="description" content="Blog, page ${n} of ${count}">
      <link rel="canonical" href="${ORIGIN}${url(n)}">${n > 1 ? `<link rel="prev" href="${ORIGIN}${url(n - 1)}">` : ''}${n < count ? `<link rel="next" href="${ORIGIN}${url(n + 1)}">` : ''}</head>
      <body>${mine.map((p) => `<a href="${p}/">post</a>`).join('')}<nav>${Array.from({ length: count }, (_, i) => `<a href="${url(i + 1)}/">${i + 1}</a>`).join('')}</nav></body></html>`);
  }
  for (const p of posts) pages.set(p, `<html><head><title>${p}</title></head><body>${p}</body></html>`);
  const sitemapXml = `<urlset>${[...Array.from({ length: count }, (_, i) => url(i + 1)), ...posts].map((r) => `<url><loc>${ORIGIN}${r}</loc></url>`).join('')}</urlset>`;
  return { pages, posts, count, sitemapXml };
}
const run = (s, extra = {}) => checkPagination({ built: s.pages, origin: ORIGIN, firstPage: '/blog', postPattern: POST, sitemapXml: s.sitemapXml, ...extra });
const edit = (s, route, fn) => { s.pages.set(route, fn(s.pages.get(route))); return s; };

describe('normRoute', () => {
  test('files and URLs become one comparable route', () => {
    assert.equal(normRoute('/blog.html'), '/blog');
    assert.equal(normRoute('/blog/page/2/index.html'), '/blog/page/2');
    assert.equal(normRoute('https://example.com/blog/page/2/'), '/blog/page/2');
    assert.equal(normRoute('/index.html'), '/');
    assert.equal(normRoute('/blog/?x=1#top'), '/blog');
  });
});

describe('checkPagination: a correct build passes', () => {
  test('3 pages, 7 posts, every post once, chain intact, sitemap complete', () => {
    const r = run(site());
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.pages, ['/blog', '/blog/page/2', '/blog/page/3']);
    assert.equal(r.posts, 7);
  });
  test('a blog that fits on one page is a single-page chain', () => {
    const r = run(site({ total: 3, perPage: 5 }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.pages, ['/blog']);
  });
});

describe('checkPagination: every way pagination can go wrong is caught', () => {
  test('a post dropped from the listing', () => {
    const s = edit(site(), '/blog/page/2', (h) => h.replace('<a href="/blog/post-4/">post</a>', ''));
    assert.match(run(s).problems.join('\n'), /1 post\(s\) are no longer reachable.*post-4/);
  });
  test('a post listed twice', () => {
    const s = edit(site(), '/blog/page/3', (h) => h.replace('<nav>', '<a href="/blog/post-1/">dup</a><nav>'));
    assert.match(run(s).problems.join('\n'), /more than one listing page.*post-1/);
  });
  test('a page whose canonical points at page 1 (a classic mistake)', () => {
    const s = edit(site(), '/blog/page/2', (h) => h.replace(`${ORIGIN}/blog/page/2"`, `${ORIGIN}/blog"`));
    assert.match(run(s).problems.join('\n'), /\/blog\/page\/2: canonical is \/blog, expected \/blog\/page\/2/);
  });
  test('a missing canonical', () => {
    const s = edit(site(), '/blog/page/3', (h) => h.replace(/<link rel="canonical"[^>]*>/, ''));
    assert.match(run(s).problems.join('\n'), /canonical is \(missing\)/);
  });
  test('a broken rel="next" chain strands the later pages', () => {
    const s = edit(site(), '/blog', (h) => h.replace(/<link rel="next"[^>]*>/, ''));
    const msg = run(s).problems.join('\n');
    assert.match(msg, /numbered page\(s\) exist but the rel="next" chain never reaches them/);
  });
  test('a wrong rel="prev"', () => {
    const s = edit(site(), '/blog/page/3', (h) => h.replace(`${ORIGIN}/blog/page/2"`, `${ORIGIN}/blog"`));
    assert.match(run(s).problems.join('\n'), /rel="prev" is \/blog, expected \/blog\/page\/2/);
  });
  test('duplicate titles and descriptions across pages', () => {
    const s = edit(site(), '/blog/page/2', (h) => h.replace('<title>Blog page 2</title>', '<title>Blog page 1</title>').replace('Blog, page 2 of 3', 'Blog, page 1 of 3'));
    const msg = run(s).problems.join('\n');
    assert.match(msg, /title duplicates \/blog/);
    assert.match(msg, /description duplicates \/blog/);
  });
  test('a pager link to a page that was never built', () => {
    const s = edit(site(), '/blog', (h) => h.replace('<nav>', '<nav><a href="/blog/page/9/">9</a>'));
    assert.match(run(s).problems.join('\n'), /pager link \/blog\/page\/9 has no built page/);
  });
  test('a post missing from the sitemap is a problem', () => {
    const s = site(); s.sitemapXml = s.sitemapXml.replace(`<url><loc>${ORIGIN}/blog/post-2</loc></url>`, '');
    const r = run(s);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /1 post\(s\) are missing from the sitemap.*post-2/);
  });
  test('a numbered listing page missing from the sitemap is only a warning (Eleventy leaves pages 2+ out of collections)', () => {
    const s = site(); s.sitemapXml = s.sitemapXml.replace(`<url><loc>${ORIGIN}/blog/page/3</loc></url>`, '').replace(`<url><loc>${ORIGIN}/blog/page/2</loc></url>`, '');
    const r = run(s);
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems, []);
    assert.match(r.warnings.join('\n'), /2 listing page\(s\) are not in the sitemap/);
  });
  test('an unrelated page that changed against the baseline build, ignoring renamed asset hashes', () => {
    const before = site(); const after = site();
    before.pages.set('/about', '<link href="/_astro/site.AAAA1111.css">About us'); after.pages.set('/about', '<link href="/_astro/site.BBBB2222.css">About us');
    assert.equal(run(after, { baseline: before.pages }).ok, true, 'only the asset filename hash differs');
    after.pages.set('/about', '<link href="/_astro/site.BBBB2222.css">About us, now with an extra pager?');
    assert.match(run(after, { baseline: before.pages }).problems.join('\n'), /existing page\(s\) outside the listing changed: \/about/);
  });
  test('Next.js build noise (random build id, hashed chunk names) is not a change; a real edit still is', () => {
    const before = site(); const after = site();
    const page = (id, chunk, body) => `<!DOCTYPE html><!--${id}--><html><body><script src="/_next/static/chunks/${chunk}.js"></script><script>x.push([1,"{\\"b\\":\\"${id}\\"}"])</script>${body}</body></html>`;
    before.pages.set('/about', page('jYQOc5j50jYVxtIPObfk8', '06ee8dbbb23de2d6', 'About us'));
    after.pages.set('/about', page('V5VcPohPv74CqL_zlVBd3', '1a2b3c4d5e6f7a8b', 'About us'));
    assert.equal(run(after, { baseline: before.pages }).ok, true);
    after.pages.set('/about', page('V5VcPohPv74CqL_zlVBd3', '1a2b3c4d5e6f7a8b', 'About us, edited'));
    assert.match(run(after, { baseline: before.pages }).problems.join('\n'), /outside the listing changed: \/about/);
  });
  test('a page that disappeared compared with the baseline', () => {
    const before = site(); const after = site(); before.pages.set('/pricing', 'x');
    assert.match(run(after, { baseline: before.pages }).problems.join('\n'), /1 existing page\(s\) disappeared: \/pricing/);
  });
  test('the first listing page was not built at all', () => {
    const s = site(); s.pages.delete('/blog');
    assert.equal(run(s).ok, false);
  });
  test('a rel="next" loop cannot hang the check', () => {
    const s = edit(site(), '/blog/page/3', (h) => h.replace('</head>', `<link rel="next" href="${ORIGIN}/blog"></head>`));
    const r = run(s); // must terminate, visiting each page once
    assert.deepEqual(r.pages, ['/blog', '/blog/page/2', '/blog/page/3']);
  });
});

describe('rel="prev"/"next" as pager anchors', () => {
  test('a chain written only as <a rel="prev|next"> in the pager is read the same as <link> tags', () => {
    const s = site();
    for (const [route, html] of s.pages) {
      if (!route.startsWith('/blog') || POST.test(route)) continue;
      const m = route === '/blog' ? 1 : Number(route.split('/').pop());
      const noLinks = html.replace(/<link rel="(prev|next)"[^>]*>/g, '').replace('<nav>', `<nav>${m > 1 ? `<a rel="prev" href="${url(m - 1)}/">p</a>` : ''}${m < s.count ? `<a rel="next" href="${url(m + 1)}/">n</a>` : ''}`);
      s.pages.set(route, noLinks);
    }
    const r = run(s);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.pages, ['/blog', '/blog/page/2', '/blog/page/3']);
  });
});

describe('describePage', () => {
  test('reads canonical, neighbours and the posts it links to', () => {
    const f = describePage(`<title> T </title><meta name="description" content="D"><link rel="canonical" href="${ORIGIN}/blog/page/2/"><link rel="prev" href="/blog"><a href="/blog/a/">a</a><a href="/about">x</a>`, { origin: ORIGIN, postPrefix: POST });
    assert.equal(f.title, 'T'); assert.equal(f.description, 'D'); assert.equal(f.canonical, '/blog/page/2'); assert.equal(f.prev, '/blog');
    assert.deepEqual([...f.posts], ['/blog/a']);
  });
});
