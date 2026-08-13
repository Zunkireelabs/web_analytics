import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePageSource } from './page-resolution.js';

// The real, repo-verified route families on zunkireelabs.com (see
// pagination-routes.test.js for the same shape read straight off real front
// matter) — used here as fixtures so this suite exercises the actual
// resolution model the remediation brief asks for: URL -> HOW IS THIS
// RENDERED -> IS IT SHARED -> WHERE IS THE ACTUAL EDITABLE SOURCE.
const GLOSSARY_ROUTE = {
  template: 'src/glossary/glossary-terms.njk', routePrefix: '/glossary', idField: 'id',
  alias: 'term', dataFile: 'src/_data/glossary.js', dataFileAmbiguous: false, layout: 'glossary-term.njk',
};
const COMPARE_ROUTE = {
  template: 'src/compare/comparison-pages.njk', routePrefix: '/compare', idField: 'id',
  alias: 'comparison', dataFile: 'src/_data/comparisons.js', dataFileAmbiguous: false, layout: 'comparison.njk',
};
const ROUTES = [GLOSSARY_ROUTE, COMPARE_ROUTE];

const site = { id: 1, repo_owner: 'Zunkireelabs', repo_name: 'zunkireelabs-web', url_file_map: {} };

describe('resolvePageSource — generated-record families', () => {
  test('a glossary term resolves to its specific data record, not the shared layout', async () => {
    const r = await resolvePageSource(site, 'https://zunkireelabs.com/glossary/multi-tenant-saas/', 'expand-content', { routes: ROUTES });

    assert.equal(r.kind, 'generated-record');
    assert.equal(r.family, '/glossary');
    assert.equal(r.renderingTemplate, 'src/glossary/glossary-terms.njk');
    assert.equal(r.layout, 'glossary-term.njk');
    assert.equal(r.isSharedTemplate, true, 'the template renders every glossary page, not just this one');
    assert.equal(r.recordId, 'multi-tenant-saas', 'derived from the URL, the same id the permalink expression uses');
    assert.deepEqual(r.editableTarget, { kind: 'data-record', path: 'src/_data/glossary.js', field: 'id' });
    assert.equal(r.affectedUrls, 'family', 'honest about the blast radius of the TEMPLATE — the record itself is narrower, but the resolver reports what a template-level edit would touch');
    assert.equal(r.blockedReason, null, 'a real data source exists — this is actionable, not blocked');
    assert.ok(r.evidence.length > 0, 'every conclusion must be traceable to real front matter, not asserted bare');
  });

  test('a compare page resolves the same way, with its own data file', async () => {
    const r = await resolvePageSource(site, 'https://zunkireelabs.com/compare/zunkiree-vs-typesense/', 'schema', { routes: ROUTES });
    assert.equal(r.kind, 'generated-record');
    assert.equal(r.dataSource.file, 'src/_data/comparisons.js');
    assert.equal(r.recordId, 'zunkiree-vs-typesense');
  });

  test('a generated route with NO discovered data file is generated-record but honestly unfixable, not silently editable', async () => {
    const noDataFile = { ...GLOSSARY_ROUTE, dataFile: null };
    const r = await resolvePageSource(site, 'https://zunkireelabs.com/glossary/foo/', 'expand-content', { routes: [noDataFile] });
    assert.equal(r.kind, 'generated-record');
    assert.deepEqual(r.editableTarget, { kind: 'none' });
    assert.ok(r.blockedReason, 'no data file means there is nowhere to write the change — this must not be reported as actionable');
    assert.match(r.blockedReason, /no per-page file to map/);
  });

  test('THE §7 SCENARIO: a page-specific field must resolve to the record, never to the shared layout file', async () => {
    // The exact hazard the remediation brief names: adding an author byline
    // or a freshness date to ONE glossary page must never target
    // glossary-term.njk, because every glossary page renders through it.
    const r = await resolvePageSource(site, 'https://zunkireelabs.com/glossary/zero-shot-learning/', 'expand-content', { routes: ROUTES });
    assert.notEqual(r.editableTarget.path, 'src/glossary/glossary-terms.njk');
    assert.notEqual(r.editableTarget.path, 'glossary-term.njk');
    assert.equal(r.editableTarget.path, 'src/_data/glossary.js');
  });
});

describe('resolvePageSource — a stored url_file_map mapping that mis-maps a shared template', () => {
  test('a config entry pointing straight at the paginating template is rejected, not trusted', async () => {
    // Simulates exactly the naive "URL -> FILE" mistake the brief warns
    // against: someone (or an earlier version of autoHealFileMapping) wrote
    // glossary/foo -> glossary-terms.njk directly into config.
    const misconfigured = {
      ...site,
      url_file_map: { pages: { '/glossary/foo': { file: 'src/glossary/glossary-terms.njk' } } },
    };
    const r = await resolvePageSource(misconfigured, 'https://zunkireelabs.com/glossary/foo/', 'expand-content', { routes: ROUTES });
    assert.equal(r.kind, 'generated-record', 'falls through to the pagination-derived answer, not the mis-mapped file');
    assert.equal(r.editableTarget.path, 'src/_data/glossary.js');
    assert.ok(r.evidence.some((e) => /mis-map/.test(e)));
  });

  test('a config entry pointing at a genuinely different, non-shared file is trusted normally', async () => {
    const configured = { ...site, url_file_map: { pages: { '/about': { file: 'src/pages/about.njk' } } } };
    const r = await resolvePageSource(configured, 'https://zunkireelabs.com/about/', 'meta-title', { routes: ROUTES });
    assert.equal(r.kind, 'authored-file');
    assert.equal(r.renderingTemplate, 'src/pages/about.njk');
    assert.equal(r.isSharedTemplate, false);
    assert.equal(r.affectedUrls, 'one');
  });
});

describe('resolvePageSource — adapter routing wins first', () => {
  test('an explicitly configured adapter is trusted over any pagination inference', async () => {
    const adapterSite = {
      ...site,
      url_file_map: {
        patterns: [{ match: '^/glossary/[^/]+$', adapters: { 'expand-content': { id: 'data-array-content', dataFile: 'src/_data/glossary.js', idField: 'id' } } }],
      },
    };
    const r = await resolvePageSource(adapterSite, 'https://zunkireelabs.com/glossary/rag/', 'expand-content', { routes: ROUTES });
    assert.equal(r.kind, 'generated-record');
    assert.equal(r.editableTarget.kind, 'data-record');
    assert.equal(r.affectedUrls, 'one', 'an adapter writes one specific record, narrower than the template-level family answer');
    assert.ok(r.evidence.some((e) => /adapter/.test(e)));
  });
});

describe('resolvePageSource — nonexistent and unknown pages', () => {
  test('a soft-404 page is reported as nonexistent, not as an unmapped page to configure', async () => {
    const r = await resolvePageSource(site, 'https://zunkireelabs.com/docs/made-up/', 'alt-text', {
      routes: ROUTES, isPageSoftNotFound: async () => true,
    });
    assert.equal(r.kind, 'nonexistent');
    assert.equal(r.blockedReason, null, 'nonexistent is not the same failure as unmapped — nothing to fix, nothing to configure');
  });

  test('no config, no route family, no soft-404 signal, no filename match — honestly unknown', async () => {
    const r = await resolvePageSource(site, 'https://zunkireelabs.com/somewhere/new/', 'meta-title', {
      routes: ROUTES, isPageSoftNotFound: async () => false,
    });
    assert.equal(r.kind, 'unknown');
    assert.ok(r.blockedReason);
  });

  test('discovers an unmapped but real, single-file match as information, without persisting it', async () => {
    const r = await resolvePageSource(site, 'https://zunkireelabs.com/blog/hello/', 'meta-title', {
      routes: ROUTES,
      isPageSoftNotFound: async () => false,
      fetchTree: async () => ({ files: ['src/blog/hello.md'], truncated: false }),
    });
    assert.equal(r.kind, 'authored-file');
    assert.equal(r.renderingTemplate, 'src/blog/hello.md');
    assert.equal(r.blockedReason, null);
  });
});

describe('resolvePageSource — family classification', () => {
  test('every resolution reports which top-level family the URL belongs to', async () => {
    assert.equal((await resolvePageSource(site, 'https://x.com/glossary/a/', 'meta-title', { routes: [] })).family, '/glossary');
    assert.equal((await resolvePageSource(site, 'https://x.com/', 'meta-title', { routes: [] })).family, null);
  });
});
