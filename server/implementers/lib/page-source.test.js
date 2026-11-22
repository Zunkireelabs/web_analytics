import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePageSource, chooseEditMethod, routeFileCandidates, findDataStores, isDynamicRouteFile, storeRoleOf, SOURCE_KIND } from './page-source.js';

// Fixture shaped like Admizz's real repo and map (catch-all patterns that over-match).
const FILES = [
  'src/app/page.tsx', 'src/app/[slug]/page.tsx', 'src/app/category/[slug]/page.tsx',
  'src/app/education-partner-in-kathmandu/page.tsx', 'src/app/study-abroad-from-nepal/page.tsx', 'src/app/privacy-policy/page.tsx',
  'src/app/course-finder/[slug]/page.tsx',
  'src/data/post-faqs.ts', 'src/data/post-seo-overrides.ts', 'src/data/generated-posts.json',
];
const DATA = {
  'src/data/post-faqs.ts': 'export const postFaqs = {\n  "london-metropolitan-university-fees": [ {q:"a"} ],\n};',
  'src/data/post-seo-overrides.ts': 'export const postSeoOverrides = {\n  "london-metropolitan-university-fees": { title: "x" },\n};',
  'src/data/generated-posts.json': '[{"slug": "neb-class-12-result", "title": "t"}]',
};
const readFile = async (f) => DATA[f] ?? null;
const site = {
  website_domain: 'example.com',
  url_file_map: { patterns: [
    { match: '^/category/([^/]+)/?$', file: 'src/app/category/[slug]/page.tsx' },
    { match: '^/([^/]+)/?$', file: 'src/app/[slug]/page.tsx' },
  ], pages: {} },
};
const src = (path, s = site) => resolvePageSource({ site: s, pageUrl: `https://example.com${path}`, files: FILES, readFile });

describe('wrong mappings are detected and corrected from the real tree', () => {
  test('a page with its own folder that the catch-all maps to [slug] is corrected to its own file', async () => {
    const r = await src('/education-partner-in-kathmandu');
    assert.equal(r.kind, SOURCE_KIND.OWN_FILE);
    assert.equal(r.file, 'src/app/education-partner-in-kathmandu/page.tsx');
    assert.equal(r.correction.from, 'src/app/[slug]/page.tsx');
    assert.match(r.correction.why, /shared/);
  });
  test('a correct own-file mapping needs no correction', async () => {
    const s = { ...site, url_file_map: { pages: { '/privacy-policy': { file: 'src/app/privacy-policy/page.tsx' } } } };
    const r = await src('/privacy-policy', s);
    assert.equal(r.kind, SOURCE_KIND.OWN_FILE); assert.equal(r.correction, undefined);
  });
  test('a mapped file that no longer exists in the tree is corrected, not trusted', async () => {
    const s = { ...site, url_file_map: { pages: { '/study-abroad-from-nepal': { file: 'src/app/old-name/page.tsx' } } } };
    const r = await src('/study-abroad-from-nepal', s);
    assert.equal(r.file, 'src/app/study-abroad-from-nepal/page.tsx'); assert.match(r.correction.why, /does not exist/);
  });
});

describe('data-driven pages', () => {
  test('a blog post living in data files is a data-record, never the [slug] template', async () => {
    const r = await src('/london-metropolitan-university-fees');
    assert.equal(r.kind, SOURCE_KIND.DATA_RECORD);
    assert.deepEqual(r.stores.map((s) => s.role).sort(), ['faq', 'meta-title']);
  });
  test('the store is chosen by what the fix changes: FAQ -> the FAQ store, meta-title -> the SEO store', async () => {
    const r = await src('/london-metropolitan-university-fees');
    assert.match(chooseEditMethod(r, 'faq').store.file, /post-faqs/);
    assert.match(chooseEditMethod(r, 'meta-title').store.file, /seo-overrides/);
  });
  test('no matching store for the change -> investigate, never the first file that mentions the slug', async () => {
    const m = chooseEditMethod(await src('/london-metropolitan-university-fees'), 'expand-content');
    assert.equal(m.method, 'investigate'); assert.equal(m.reason, 'no-matching-data-store');
  });
  test('a slug that only appears in prose is not a record', async () => {
    const stores = await findDataStores('mention', ['src/data/a.json'], async () => '{"text": "see mention here"}');
    assert.deepEqual(stores, []);
  });
});

describe('shared templates and unresolved pages stop the agent', () => {
  test('a category page is a shared template: page-specific fixes are refused, breadcrumbs may edit the template', async () => {
    const r = await src('/category/uk');
    assert.equal(r.kind, SOURCE_KIND.SHARED_TEMPLATE);
    assert.equal(chooseEditMethod(r, 'faq').method, 'investigate');
    assert.equal(chooseEditMethod(r, 'faq').reason, 'shared-template-page-specific-change');
    assert.equal(chooseEditMethod(r, 'breadcrumbs').method, 'template-edit');
  });
  test('course-finder routes (not in the map, rendered by a dynamic route) are shared, not written to', async () => {
    const r = await src('/course-finder/msc-computer-science');
    assert.notEqual(r.kind, SOURCE_KIND.OWN_FILE);
    assert.equal(chooseEditMethod(r, 'qa-content').method, 'investigate');
  });
  test('a page with no verifiable source is unresolved and stops', async () => {
    const r = await resolvePageSource({ site: { website_domain: 'example.com', url_file_map: {} }, pageUrl: 'https://example.com/nowhere/at-all', files: FILES, readFile });
    assert.equal(r.kind, SOURCE_KIND.UNRESOLVED);
    const m = chooseEditMethod(r, 'faq');
    assert.equal(m.method, 'investigate'); assert.match(m.message, /will not write to a guessed file/);
  });
  test('two possible own files are ambiguous: stop', async () => {
    const files = ['src/app/x/page.tsx', 'src/pages/x.tsx'];
    const r = await resolvePageSource({ site: { website_domain: 'example.com', url_file_map: {} }, pageUrl: 'https://example.com/x', files, readFile });
    assert.equal(r.kind, SOURCE_KIND.UNRESOLVED); assert.equal(r.reason, 'ambiguous-own-file');
  });
});

describe('works across stacks, not just Next.js', () => {
  test('Astro and Eleventy own files are found from the tree', () => {
    assert.deepEqual(routeFileCandidates('https://a.com/pricing', ['src/pages/pricing.astro', 'src/pages/[slug].astro']), ['src/pages/pricing.astro']);
    assert.deepEqual(routeFileCandidates('https://a.com/faq', ['src/faq.njk', 'src/_includes/x.njk']), ['src/faq.njk']);
  });
  test('route-parameter files are recognised as shared', () => {
    for (const f of ['src/app/[slug]/page.tsx', 'src/pages/[id].astro', 'src/blog/$1.njk']) assert.equal(isDynamicRouteFile(f), true, f);
    assert.equal(isDynamicRouteFile('src/app/about/page.tsx'), false);
  });
  test('store roles come from file names', () => {
    assert.equal(storeRoleOf('src/data/post-faqs.ts'), 'faq');
    assert.equal(storeRoleOf('src/data/post-seo-overrides.ts'), 'meta-title');
  });
});
