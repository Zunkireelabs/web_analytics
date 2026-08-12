import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPageMapped, resolveNewContentTarget, resolveNewContentUrl, resolveNewContentLayout } from './url-file-map.js';

// Regression coverage for a real report: zunkireelabs-web's `/compare/:slug`
// pattern configures `adapters` for faq/meta-title only (no `file`, no
// `schema` adapter) — a schema recommendation for
// /compare/zunkiree-vs-elasticsearch/ generated an "auto-eligible" card that
// failed every time someone tried to apply it ("No url_file_map entry
// matches..."). isPageMapped is the pre-check that lets
// agents/lib/recommendations.js skip creating that recommendation at all.
describe('isPageMapped', () => {
  const site = {
    url_file_map: {
      pages: { '/about': { file: 'src/pages/about.njk' } },
      patterns: [
        {
          match: '^/compare/([^/]+)$',
          adapters: {
            faq: { id: 'data-array-content', dataFile: 'src/_data/comparisons.js', itemsField: 'faqs' },
            'meta-title': { id: 'data-array-content', dataFile: 'src/_data/comparisons.js', fields: { title: 'title' } },
          },
        },
        { match: '^/blog/([^/]+)$', file: 'src/blog/$1.md' },
      ],
    },
  };

  test('a page with no adapter and no file/pattern match is not mapped', () => {
    assert.equal(isPageMapped(site, 'https://example.com/compare/zunkiree-vs-elasticsearch/', 'schema'), false);
  });

  test('an action type with an adapter route counts as mapped, even without a `file`', () => {
    assert.equal(isPageMapped(site, 'https://example.com/compare/zunkiree-vs-elasticsearch/', 'faq'), true);
    assert.equal(isPageMapped(site, 'https://example.com/compare/zunkiree-vs-elasticsearch/', 'meta-title'), true);
  });

  test('an exact `pages` entry with a real file counts as mapped for any action type', () => {
    assert.equal(isPageMapped(site, 'https://example.com/about', 'schema'), true);
  });

  test('a `patterns` entry with a real file counts as mapped for any action type', () => {
    assert.equal(isPageMapped(site, 'https://example.com/blog/my-post', 'schema'), true);
  });

  test('a page matching nothing at all is not mapped', () => {
    assert.equal(isPageMapped(site, 'https://example.com/nowhere', 'schema'), false);
  });
});

// A new page's public URL — the half that makes it reachable in a build-time
// generated sitemap without a second draft/PR. Deliberately config-driven:
// the directory -> URL mapping is a property of the site's build setup this
// code cannot observe, and a guessed URL would publish a real page at a URL
// that 404s and then advertise it in the sitemap.
describe('resolveNewContentUrl', () => {
  const site = (targets) => ({ url_file_map: { newContentTargets: targets } });

  test('resolves the configured urlPattern against the same slug as the file path', () => {
    const s = site({ 'blog-outline': { dir: 'src/blog', extension: '.md', urlPattern: '/blog/{slug}/' } });
    assert.equal(resolveNewContentUrl(s, 'blog-outline', 'Boiler Care 101'), '/blog/boiler-care-101/');
    assert.equal(resolveNewContentTarget(s, 'blog-outline', 'Boiler Care 101'), 'src/blog/boiler-care-101.md');
  });

  test('the URL slug and the file slug can never diverge, however odd the title', () => {
    const s = site({ 'landing-page': { dir: 'src/pages', extension: '.njk', urlPattern: '/services/{slug}/' } });
    const title = '  AI & Automation — Kathmandu!! ';
    const filePath = resolveNewContentTarget(s, 'landing-page', title);
    const url = resolveNewContentUrl(s, 'landing-page', title);
    assert.equal(filePath, 'src/pages/ai-automation-kathmandu.njk');
    assert.equal(url, '/services/ai-automation-kathmandu/');
  });

  test('no urlPattern configured returns null — the page is still created, it just gets no permalink', () => {
    const s = site({ 'blog-outline': { dir: 'src/blog', extension: '.md' } });
    assert.equal(resolveNewContentUrl(s, 'blog-outline', 'Anything'), null);
    assert.equal(resolveNewContentTarget(s, 'blog-outline', 'Anything'), 'src/blog/anything.md');
  });

  test('no config at all for that action type returns null', () => {
    assert.equal(resolveNewContentUrl(site({}), 'landing-page', 'X'), null);
    assert.equal(resolveNewContentUrl({ url_file_map: {} }, 'landing-page', 'X'), null);
  });

  test('a urlPattern with no {slug} token is unusable config, not a URL to guess at', () => {
    assert.equal(resolveNewContentUrl(site({ 'blog-outline': { urlPattern: '/blog/' } }), 'blog-outline', 'X'), null);
  });

  test('rejects a malformed pattern rather than normalizing it into a guess', () => {
    const bad = ['https://example.com/{slug}/', 'blog/{slug}/', '/blog/../{slug}/', '/blog//{slug}/'];
    for (const urlPattern of bad) {
      assert.equal(resolveNewContentUrl(site({ 'blog-outline': { urlPattern } }), 'blog-outline', 'X'), null, urlPattern);
    }
  });
});

// A new page with the right content but no layout renders as a bare document —
// no navbar, no footer, no site chrome. Resolved by BASENAME because that is
// what Eleventy's `layout:` value means: it resolves relative to dir.layouts,
// not the project root (zunkireelabs-web sets dir.layouts = "_includes/layouts"
// and its own pages declare `layout: base.njk`).
describe('resolveNewContentLayout', () => {
  const withLayout = (extra = {}) => ({
    url_file_map: { siteRoot: { layoutTemplate: 'src/_includes/layouts/base.njk' }, ...extra },
  });

  test('derives the layout name from the configured layoutTemplate path', () => {
    assert.equal(resolveNewContentLayout(withLayout(), 'landing-page'), 'base.njk');
  });

  test('no layoutTemplate configured -> null, key omitted, exactly today\'s behavior', () => {
    assert.equal(resolveNewContentLayout({ url_file_map: {} }, 'landing-page'), null);
    assert.equal(resolveNewContentLayout({}, 'landing-page'), null);
    assert.equal(resolveNewContentLayout(null, 'landing-page'), null);
  });

  // The real hazard: front matter overrides directory data, so emitting the
  // generic site layout onto a new blog post would silently downgrade it from
  // the blog layout its directory already assigns.
  test('an explicit per-target null suppresses it, for a directory that supplies its own layout', () => {
    const site = withLayout({ newContentTargets: { 'blog-outline': { dir: 'src/blog', extension: '.md', layout: null } } });
    assert.equal(resolveNewContentLayout(site, 'blog-outline'), null);
    assert.equal(resolveNewContentLayout(site, 'landing-page'), 'base.njk', 'other targets still get the site default');
  });

  test('an explicit per-target string overrides the site default outright', () => {
    const site = withLayout({ newContentTargets: { 'blog-outline': { layout: 'blog-post.njk' } } });
    assert.equal(resolveNewContentLayout(site, 'blog-outline'), 'blog-post.njk');
  });

  test('a target with no layout key at all falls back to the site default', () => {
    const site = withLayout({ newContentTargets: { 'landing-page': { dir: 'src/pages', extension: '.njk' } } });
    assert.equal(resolveNewContentLayout(site, 'landing-page'), 'base.njk');
  });
});
