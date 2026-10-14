import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDiscovery } from './run-discovery.js';
import { resolveFile, isPageMapped } from '../implementers/lib/url-file-map.js';

// End-to-end proof (requirement 8): a newly connected Next.js App Router
// repo, run through discovery exactly the way connect-repo.js now does it,
// ends up with a url_file_map whose entries genuinely resolve through the
// SAME production resolver every generator uses — not just a report that
// says so.

const NEXTJS_APP_ROUTER_FILES = [
  'package.json', 'package-lock.json', 'next.config.js', 'tsconfig.json',
  'src/app/layout.tsx', 'src/app/page.tsx',
  'src/app/about/page.tsx',
  'src/app/blog/[slug]/page.tsx',
  'src/app/blog/[slug]/loading.tsx',
  'src/app/(marketing)/pricing/page.tsx',
];

function fakeSite(overrides = {}) {
  return { id: 8862, name: 'Fixture Site', website_domain: 'example.com', repo_owner: 'acme', repo_name: 'acme-web', repo_default_branch: 'main', url_file_map: {}, ...overrides };
}

async function runOnFiles(files, { site: siteOverrides = {}, persistOverride } = {}) {
  const site = fakeSite(siteOverrides);
  const persisted = [];
  const written = { urlFileMap: site.url_file_map };

  const result = await runDiscovery(site, {
    fetchTree: async () => ({ files, truncated: false }),
    fetchFile: async (s, path) => {
      if (path === 'package.json') return { content: JSON.stringify({ dependencies: { next: '14.2.0' } }) };
      return null;
    },
    persist: persistOverride || (async (siteId, row) => { persisted.push(row); return { status: row.status }; }),
    summarize: async () => [],
    saveConfig: async ({ urlFileMap }) => { written.urlFileMap = urlFileMap; return { ...site, url_file_map: urlFileMap }; },
  });

  return { result, persisted, written };
}

describe('runDiscovery — Next.js App Router, end to end', () => {
  test('detects the framework from real evidence', async () => {
    const { result } = await runOnFiles(NEXTJS_APP_ROUTER_FILES);
    assert.equal(result.ok, true);
    assert.equal(result.technology.framework.id, 'nextjs');
  });

  test('layout.tsx/loading.tsx are never proposed as routes', async () => {
    const { result } = await runOnFiles(NEXTJS_APP_ROUTER_FILES);
    const files = [...result.routes.routes.map((r) => r.file), ...result.routes.families.map((f) => f.templateFile)];
    assert.ok(!files.includes('src/app/layout.tsx'));
    assert.ok(!files.includes('src/app/blog/[slug]/loading.tsx'));
  });

  test('static routes, a dynamic family, and render capabilities all auto-configure and read back through resolveFile', async () => {
    const { written } = await runOnFiles(NEXTJS_APP_ROUTER_FILES);
    const site = { url_file_map: written.urlFileMap, website_domain: 'example.com' };

    assert.equal(resolveFile(site, 'https://example.com/'), 'src/app/page.tsx');
    assert.equal(resolveFile(site, 'https://example.com/about'), 'src/app/about/page.tsx');
    // The route group contributes no URL segment but the file still lives
    // under (marketing)/ on disk.
    assert.equal(resolveFile(site, 'https://example.com/pricing'), 'src/app/(marketing)/pricing/page.tsx');
    // The dynamic family resolves ANY slug to the one real template file.
    assert.equal(resolveFile(site, 'https://example.com/blog/how-we-shipped-this'), 'src/app/blog/[slug]/page.tsx');
    assert.equal(isPageMapped(site, 'https://example.com/blog/anything-else', 'meta-title'), true);

    assert.equal(site.url_file_map.renderCapabilities.generator, 'nextjs');
    assert.equal(site.url_file_map.renderCapabilities.extensions['.tsx'].markdown, false);
  });

  // Real incident, site #8862 (Admizz): website_domain was stored as
  // "https://admizzeducation.com/" (scheme + trailing slash), not a bare
  // hostname. Building a probe as `https://${site.website_domain}...`
  // produced "https://https://admizzeducation.com/...", whose hostname
  // parses to the literal string "https" — every single validation then
  // failed as "foreign hostname," rejecting all 74 correct static routes
  // and both dynamic families in one pass, even though every one of them
  // was actually correct.
  test('a website_domain stored with a scheme and trailing slash does not fail every validation', async () => {
    const { written } = await runOnFiles(NEXTJS_APP_ROUTER_FILES, { site: { website_domain: 'https://example.com/' } });
    assert.equal(written.urlFileMap.pages['/'].file, 'src/app/page.tsx');
    assert.equal(written.urlFileMap.pages['/about'].file, 'src/app/about/page.tsx');
    assert.ok(written.urlFileMap.patterns.some((p) => p.file === 'src/app/blog/[slug]/page.tsx'));
  });

  // Real incident, site #8862 (Admizz): a `[slug]/page.tsx` catch-all sits
  // beside 74 real static directories (`app/about/page.tsx`,
  // `app/careers/page.tsx`, ...) — a routing shape Next.js explicitly
  // supports, with the static segment winning at request time. Recording
  // the dynamic family BEFORE the static routes made this finding's own
  // "already resolvable, skip" check see /about resolving via the WRONG
  // catch-all pattern and never write its correct exact entry — 64 of 74
  // static pages silently lost their real mapping on the very first run.
  test('a static route directory beside a [slug] catch-all still gets its own correct exact entry', async () => {
    const files = [
      'package.json', 'package-lock.json', 'next.config.js',
      'src/app/page.tsx',
      'src/app/about/page.tsx',
      'src/app/careers/page.tsx',
      'src/app/[slug]/page.tsx',
    ];
    const { written } = await runOnFiles(files);
    assert.equal(written.urlFileMap.pages['/about'].file, 'src/app/about/page.tsx');
    assert.equal(written.urlFileMap.pages['/careers'].file, 'src/app/careers/page.tsx');
    // The catch-all still gets written too, for every slug NOT already static.
    assert.ok(written.urlFileMap.patterns.some((p) => p.file === 'src/app/[slug]/page.tsx'));
    const site = { url_file_map: written.urlFileMap, website_domain: 'example.com' };
    assert.equal(resolveFile(site, 'https://example.com/about'), 'src/app/about/page.tsx');
    assert.equal(resolveFile(site, 'https://example.com/anything-else'), 'src/app/[slug]/page.tsx');
  });

  test('a page a human already explicitly mapped is never overwritten by discovery', async () => {
    const humanMap = { pages: { '/about': { file: 'src/app/about/CUSTOM.tsx' } } };
    const { written } = await runOnFiles(NEXTJS_APP_ROUTER_FILES, { site: { url_file_map: humanMap } });
    assert.equal(written.urlFileMap.pages['/about'].file, 'src/app/about/CUSTOM.tsx');
  });

  test('every finding this recorded names real, checkable evidence', async () => {
    const { persisted } = await runOnFiles(NEXTJS_APP_ROUTER_FILES);
    assert.ok(persisted.length > 0);
    for (const row of persisted) {
      assert.ok(Array.isArray(row.evidence) && row.evidence.length > 0, `${row.category}/${row.subject} has no evidence`);
    }
  });
});

describe('runDiscovery — a repo with no repo configured is a clean no-op', () => {
  test('returns a clear reason, touches nothing', async () => {
    const site = fakeSite({ repo_owner: null, repo_name: null });
    const result = await runDiscovery(site, { fetchTree: async () => { throw new Error('must not be called'); } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-repo-configured');
  });
});
