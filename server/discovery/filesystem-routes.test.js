import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { discoverFilesystemRoutes } from './filesystem-routes.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';

// Every dynamic family this module proposes is only meaningful if it
// actually round-trips through the SAME resolver production code uses —
// these tests prove that, not just that the raw shape looks right.
function assertFamilyResolves(family, expectedFile) {
  const site = { url_file_map: { patterns: [{ match: family.routePattern, file: family.templateFile }] } };
  const probe = family.sampleRoutes[0];
  const resolved = resolveFile(site, `https://example.com${probe}`);
  assert.equal(resolved, expectedFile, `probe route ${probe} must resolve back to ${expectedFile} (got ${resolved})`);
}

describe('Next.js App Router', () => {
  test('root and nested static pages map to exact routes', () => {
    const files = [
      'src/app/page.tsx',
      'src/app/about/page.tsx',
      'src/app/about/team/page.tsx',
      'src/app/layout.tsx', // must never be treated as a route
    ];
    const result = discoverFilesystemRoutes({ frameworkId: 'nextjs', files });
    assert.deepEqual(
      result.staticRoutes.map((r) => [r.route, r.file]).sort(),
      [
        ['/', 'src/app/page.tsx'],
        ['/about', 'src/app/about/page.tsx'],
        ['/about/team', 'src/app/about/team/page.tsx'],
      ].sort()
    );
    assert.equal(result.families.length, 0);
  });

  test('a dynamic segment produces a validated pattern family, not a per-slug guess', () => {
    const files = ['src/app/blog/[slug]/page.tsx'];
    const result = discoverFilesystemRoutes({ frameworkId: 'nextjs', files });
    assert.equal(result.staticRoutes.length, 0);
    assert.equal(result.families.length, 1);
    const family = result.families[0];
    assert.equal(family.templateFile, 'src/app/blog/[slug]/page.tsx');
    assertFamilyResolves(family, 'src/app/blog/[slug]/page.tsx');
  });

  test('route groups contribute no URL segment but stay in the file path', () => {
    const files = ['src/app/(marketing)/pricing/page.tsx'];
    const result = discoverFilesystemRoutes({ frameworkId: 'nextjs', files });
    assert.equal(result.staticRoutes.length, 1);
    assert.equal(result.staticRoutes[0].route, '/pricing');
    assert.equal(result.staticRoutes[0].file, 'src/app/(marketing)/pricing/page.tsx');
  });

  test('catch-all and optional catch-all segments resolve through the real regex', () => {
    const files = ['src/app/docs/[...slug]/page.tsx', 'src/app/shop/[[...filters]]/page.tsx'];
    const result = discoverFilesystemRoutes({ frameworkId: 'nextjs', files });
    assert.equal(result.families.length, 2);
    for (const family of result.families) assertFamilyResolves(family, family.templateFile);
  });

  test('a parallel-route slot is refused, never guessed', () => {
    const files = ['src/app/dashboard/@analytics/page.tsx'];
    const result = discoverFilesystemRoutes({ frameworkId: 'nextjs', files });
    assert.equal(result.staticRoutes.length, 0);
    assert.equal(result.families.length, 0);
    assert.equal(result.unresolved.length, 1);
  });

  test('layout/loading/error/route/middleware files are never treated as pages', () => {
    const files = [
      'src/app/blog/layout.tsx',
      'src/app/blog/loading.tsx',
      'src/app/blog/error.tsx',
      'src/app/blog/route.ts',
      'src/middleware.ts',
    ];
    const result = discoverFilesystemRoutes({ frameworkId: 'nextjs', files });
    assert.equal(result.staticRoutes.length, 0);
    assert.equal(result.families.length, 0);
  });
});

describe('Next.js Pages Router', () => {
  test('static and index pages resolve to the right routes, reserved files excluded', () => {
    const files = [
      'src/pages/index.tsx',
      'src/pages/about.tsx',
      'src/pages/blog/index.tsx',
      'src/pages/_app.tsx',
      'src/pages/_document.tsx',
      'src/pages/api/hello.ts',
    ];
    const result = discoverFilesystemRoutes({ frameworkId: 'nextjs', files });
    assert.deepEqual(
      result.staticRoutes.map((r) => [r.route, r.file]).sort(),
      [
        ['/', 'src/pages/index.tsx'],
        ['/about', 'src/pages/about.tsx'],
        ['/blog', 'src/pages/blog/index.tsx'],
      ].sort()
    );
  });

  test('a dynamic filename segment produces a validated family', () => {
    const files = ['src/pages/blog/[slug].tsx'];
    const result = discoverFilesystemRoutes({ frameworkId: 'nextjs', files });
    assert.equal(result.families.length, 1);
    const family = result.families[0];
    assert.equal(family.templateFile, 'src/pages/blog/[slug].tsx');
    assertFamilyResolves(family, 'src/pages/blog/[slug].tsx');
  });
});

describe('Astro file-based pages', () => {
  test('static .astro/.md pages resolve, private files excluded', () => {
    const files = ['src/pages/index.astro', 'src/pages/about.astro', 'src/pages/blog/post-1.md', 'src/pages/_draft.astro'];
    const result = discoverFilesystemRoutes({ frameworkId: 'astro', files });
    assert.deepEqual(
      result.staticRoutes.map((r) => r.route).sort(),
      ['/', '/about', '/blog/post-1']
    );
  });

  test('a dynamic .astro segment produces a validated family', () => {
    const files = ['src/pages/products/[id].astro'];
    const result = discoverFilesystemRoutes({ frameworkId: 'astro', files });
    assert.equal(result.families.length, 1);
    assertFamilyResolves(result.families[0], 'src/pages/products/[id].astro');
  });

  test('a non-astro framework never runs Next.js router logic against a coincidental pages/ dir', () => {
    // Eleventy sites also use src/pages/*.njk (front-matter-routed) —
    // running this module against them would apply the WRONG spec.
    const files = ['src/pages/about.njk'];
    const result = discoverFilesystemRoutes({ frameworkId: 'eleventy', files });
    assert.equal(result.staticRoutes.length, 0);
    assert.equal(result.families.length, 0);
  });
});
