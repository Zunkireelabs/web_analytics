import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPageMapped, resolveFile, resolveHostScope, resolveNewContentTarget, resolveNewContentUrl, resolveNewContentLayout,
  resolveMarkers,
} from './url-file-map.js';

// Regression coverage for a real report: zunkireelabs-web's `/compare/:slug`
// pattern configures `adapters` for faq/meta-title only (no `file`, no
// `schema` adapter) — a schema recommendation for
// /compare/zunkiree-vs-elasticsearch/ generated an "auto-eligible" card that
// failed every time someone tried to apply it ("No url_file_map entry
// matches..."). isPageMapped is the pre-check that lets
// agents/lib/recommendations.js skip creating that recommendation at all.
// None of these marker names are a genuine per-tenant naming choice — there
// is exactly one real field per action type, fixed by the generator itself,
// and no tenant has a real reason to want a different name for e.g. "the FAQ
// marker" — so every marker-merge action type falls back to a built-in
// platform default rather than requiring a human to hand-author
// `defaults.placements` first. Real incidents this generalizes:
// site #8862 had ga4/facebook-pixel IDs configured in the database but no
// placements config at all, so every analytics-install draft failed "no
// markers configured" regardless (fixed first, for that one action type
// only) — then the SAME site, being the first Next.js/App-Router site ever
// connected, hit the identical failure for all 9 other marker-merge action
// types, because only Zunkiree Labs (Eleventy) had ever hand-authored a
// `defaults.placements` block. Generalizing the platform default to every
// marker-merge type (not just analytics-install) is the actual fix — see
// MARKER_FIELD_BY_ACTION_TYPE in url-file-map.js.
describe('resolveMarkers — every marker-merge action type has a built-in platform default', () => {
  test('falls back to the platform default when nothing is configured', () => {
    const site = { url_file_map: {} };
    assert.deepEqual(resolveMarkers(site, null, 'analytics-install'), {
      analyticsScriptGa4: 'ANALYTICSSCRIPTGA4',
      analyticsScriptFacebookPixel: 'ANALYTICSSCRIPTFACEBOOKPIXEL',
    });
    // meta-title has two real fields, not one — see PLATFORM_DEFAULT_MARKERS'
    // own comment for the bug this fixed (description silently had no
    // default marker at all, so it could never be written).
    assert.deepEqual(resolveMarkers(site, 'https://example.com/', 'meta-title'), { title: 'TITLE', description: 'METADESCRIPTION' });
    assert.deepEqual(resolveMarkers(site, 'https://example.com/', 'faq'), { faq: 'FAQ' });
    assert.deepEqual(resolveMarkers(site, 'https://example.com/', 'schema'), { schema: 'SCHEMA' });
    assert.deepEqual(resolveMarkers(site, 'https://example.com/', 'internal-links'), { links: 'INTERNALLINKS' });
    assert.deepEqual(resolveMarkers(site, 'https://example.com/', 'canonical'), { canonical: 'CANONICAL' });
    assert.deepEqual(resolveMarkers(site, 'https://example.com/', 'open-graph'), { openGraph: 'OPENGRAPH' });
    assert.deepEqual(resolveMarkers(site, 'https://example.com/', 'expand-content'), { expandedContent: 'EXPANDEDCONTENT' });
    assert.deepEqual(resolveMarkers(site, 'https://example.com/', 'qa-content'), { qaContent: 'QACONTENT' });
    assert.deepEqual(resolveMarkers(site, 'https://example.com/', 'breadcrumbs'), { breadcrumbSchema: 'BREADCRUMBSCHEMA' });
  });

  test('an explicit site-level default still wins over the platform default', () => {
    const site = { url_file_map: { defaults: { placements: { 'analytics-install': { markers: { analyticsScriptGa4: 'CUSTOM_GA4' } } } } } };
    assert.deepEqual(resolveMarkers(site, null, 'analytics-install'), { analyticsScriptGa4: 'CUSTOM_GA4' });
  });

  test('an action type outside the marker-merge set still returns no platform default', () => {
    const site = { url_file_map: {} };
    assert.equal(resolveMarkers(site, 'https://example.com/', 'blog-outline'), null);
  });
});

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

// Real incident, 2026-08-24: site 1 (Zunkiree Labs) has THREE registered
// real hostnames — website_domain zunkireelabs.com, plus
// additional_own_domains edgex.zunkireelabs.com and zenly.zunkireelabs.com
// (migration 123, the "hero product on its own subdomain" case). `pages`/
// `patterns` were path-only, so edgex.zunkireelabs.com/ silently resolved
// to the MAIN site's homepage file the moment `/` got mapped for
// zunkireelabs.com — 17 real recommendations had to be manually dismissed.
// This is the fix: hostname is now part of a page's identity via the
// explicit-only `url_file_map.hosts[hostname]` namespace (see
// resolveHostScope's own doc comment in url-file-map.js).
describe('hostname-aware resolution — the same path on different hostnames must never collapse into one mapping', () => {
  const multiHostSite = {
    website_domain: 'zunkireelabs.com',
    additional_own_domains: ['edgex.zunkireelabs.com', 'zenly.zunkireelabs.com'],
    url_file_map: {
      // Primary domain — the flat, legacy namespace. Unchanged shape.
      pages: {
        '/': { file: 'src/pages/index.njk' },
        '/contact': { file: 'src/pages/contact.njk' },
      },
      patterns: [{ match: '^/resources/([^/]+)/?$', file: 'src/pages/resources/$1.njk' }],
      // A registered non-primary domain with its OWN, independent
      // mappings — explicitly configured, never auto-derived.
      hosts: {
        'edgex.zunkireelabs.com': {
          pages: { '/': { file: 'src/edgex/home.njk' } },
          patterns: [{ match: '^/pricing/?$', file: 'src/edgex/pricing.njk' }],
        },
        // zenly.zunkireelabs.com is registered but has NO hosts[] entry at
        // all yet — must resolve to nothing, not silently borrow the
        // primary domain's mapping.
      },
    },
  };

  test('same path ("/") on two different registered hostnames resolves to two different files', () => {
    assert.equal(resolveFile(multiHostSite, 'https://zunkireelabs.com/'), 'src/pages/index.njk');
    assert.equal(resolveFile(multiHostSite, 'https://edgex.zunkireelabs.com/'), 'src/edgex/home.njk');
  });

  test('root "/" on a registered hostname with no hosts[] entry resolves to nothing — never inherits the primary mapping', () => {
    assert.equal(resolveFile(multiHostSite, 'https://zenly.zunkireelabs.com/'), null);
    assert.equal(isPageMapped(multiHostSite, 'https://zenly.zunkireelabs.com/', 'meta-title'), false);
  });

  test('/contact/ on a registered hostname with no hosts[] entry resolves to nothing, even though the exact path exists on the primary domain', () => {
    assert.equal(resolveFile(multiHostSite, 'https://edgex.zunkireelabs.com/contact/'), null);
    assert.equal(resolveFile(multiHostSite, 'https://zenly.zunkireelabs.com/contact/'), null);
    // The real incident this regression covers: this must NEVER equal
    // 'src/pages/contact.njk', the primary domain's own file.
    assert.notEqual(resolveFile(multiHostSite, 'https://edgex.zunkireelabs.com/contact/'), 'src/pages/contact.njk');
  });

  test('a pattern-based mapping is also hostname-scoped, not just exact pages[] entries', () => {
    assert.equal(resolveFile(multiHostSite, 'https://edgex.zunkireelabs.com/pricing/'), 'src/edgex/pricing.njk');
    assert.equal(resolveFile(multiHostSite, 'https://zunkireelabs.com/pricing/'), null, 'the primary domain never configured this pattern');
  });

  test('legitimate same-host mappings keep working exactly as before — zero behavior change for the common single-hostname case', () => {
    assert.equal(resolveFile(multiHostSite, 'https://zunkireelabs.com/'), 'src/pages/index.njk');
    assert.equal(resolveFile(multiHostSite, 'https://zunkireelabs.com/contact/'), 'src/pages/contact.njk');
    assert.equal(resolveFile(multiHostSite, 'https://zunkireelabs.com/resources/what-is-gaas/'), 'src/pages/resources/what-is-gaas.njk');
    assert.equal(isPageMapped(multiHostSite, 'https://zunkireelabs.com/', 'meta-title'), true);
  });

  test('a URL on a hostname the site never registered at all is likewise never accidentally resolved', () => {
    // resolveFile itself does not distinguish "foreign" from "registered but
    // unconfigured" (that judgment belongs to the own-domain guard in
    // discover-file-mapping.js) — both correctly resolve to nothing here,
    // which is exactly the protection foreign-domain rejection depends on.
    assert.equal(resolveFile(multiHostSite, 'https://supreme-court.zunkireelabs.com/'), null);
    assert.equal(resolveFile(multiHostSite, 'https://dev-web.zunkireelabs.com/contact/'), null);
  });

  test('a bare path with no hostname (an existing internal calling convention) still resolves via the legacy flat namespace', () => {
    assert.equal(resolveFile(multiHostSite, '/'), 'src/pages/index.njk');
    assert.equal(resolveFile(multiHostSite, '/contact'), 'src/pages/contact.njk');
  });

  test('a site with no website_domain configured at all is never hostname-scoped — full backward compatibility for pre-onboarding sites', () => {
    const noDomainSite = { url_file_map: { pages: { '/about': { file: 'src/pages/about.njk' } } } };
    assert.equal(resolveFile(noDomainSite, 'https://example.com/about'), 'src/pages/about.njk');
    assert.equal(resolveFile(noDomainSite, 'https://totally-different-host.com/about'), 'src/pages/about.njk');
  });

  test('resolveHostScope reports which scope it used, for callers (autoHealFileMapping) that need to branch on it', () => {
    assert.equal(resolveHostScope(multiHostSite, 'https://zunkireelabs.com/').scope, 'primary');
    assert.equal(resolveHostScope(multiHostSite, 'https://edgex.zunkireelabs.com/').scope, 'host');
    assert.equal(resolveHostScope(multiHostSite, '/about').scope, 'legacy');
    assert.equal(resolveHostScope({ url_file_map: {} }, 'https://example.com/').scope, 'legacy');
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
