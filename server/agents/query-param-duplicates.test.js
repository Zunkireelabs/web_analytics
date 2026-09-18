import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let inventory;
let perfRowsByPage;
let queryRows;

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async () => site,
    getSearchPerformanceForPages: async (siteId, start, end, pages) => (
      pages.filter((p) => perfRowsByPage.has(p)).map((p) => ({ dim_value: p, ...perfRowsByPage.get(p) }))
    ),
    getQueryPageMetrics: async () => queryRows,
  },
});
mock.module(resolve('../store/page-inventory.js'), {
  namedExports: { listPageInventory: async () => inventory },
});
// Defaults to "unclassified" (null) so every pre-existing test's split-
// traffic outcome is unaffected. Individual tests override contentTypeByPage
// to exercise the new page-purpose escalation path.
let contentTypeByPage = null;
mock.module(resolve('./lib/page-content-classifier.js'), {
  namedExports: {
    getOrClassifyPageContentType: async (siteId, page) => {
      const type = typeof contentTypeByPage === 'function' ? contentTypeByPage(page) : contentTypeByPage;
      return type ? { contentType: type, confidence: 0.9, classifiedBy: 'path' } : null;
    },
  },
});

const { run } = await import('./query-param-duplicates.js');

beforeEach(() => {
  site = { id: 1, timezone: 'UTC' };
  inventory = [];
  perfRowsByPage = new Map();
  queryRows = [];
  contentTypeByPage = null;
});

describe('query-param-duplicates agent', () => {
  test('insufficient-data with no inventory yet', async () => {
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('no finding when a page has only one query-string variant alongside its base', async () => {
    inventory = [
      { page: 'https://example.com/resources/', orphaned: false },
      { page: 'https://example.com/resources/?type=ebook', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  test('orphaned rows are excluded', async () => {
    inventory = [
      { page: 'https://example.com/resources/?type=ebook', orphaned: true },
      { page: 'https://example.com/resources/?type=case-study', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  describe('confidence-gated evidence', () => {
    test('HIGH confidence: exactly one variant has all the real traffic -> auto-drafts a canonical consolidation', async () => {
      inventory = [
        { page: 'https://example.com/resources/', orphaned: false },
        { page: 'https://example.com/resources/?type=ebook', orphaned: false },
        { page: 'https://example.com/resources/?type=case-study', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/resources/', { clicks: 20, impressions: 150 });
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.evidence.winner, 'https://example.com/resources/');
      assert.equal(finding.recommendedAction.generatorId, 'canonical');
      assert.equal(finding.recommendedAction.params.canonicalTarget, 'https://example.com/resources/');
      assert.notEqual(finding.recommendedAction.params.page, 'https://example.com/resources/');
      assert.equal(result.facts.autoConsolidated, 1);
    });

    test('MEDIUM confidence: two variants both show real traffic -> stays reportOnly', async () => {
      inventory = [
        { page: 'https://example.com/resources/?type=ebook', orphaned: false },
        { page: 'https://example.com/resources/?type=case-study', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/resources/?type=ebook', { clicks: 10, impressions: 100 });
      perfRowsByPage.set('https://example.com/resources/?type=case-study', { clicks: 5, impressions: 50 });
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'medium');
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.kind, 'query-param-duplicate');
    });

    test('MEDIUM escalates to HIGH when query sets overlap substantially and one variant has strictly more clicks (no bare URL in the group)', async () => {
      inventory = [
        { page: 'https://example.com/resources/?type=ebook', orphaned: false },
        { page: 'https://example.com/resources/?type=case-study', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/resources/?type=ebook', { clicks: 30, impressions: 300 });
      perfRowsByPage.set('https://example.com/resources/?type=case-study', { clicks: 4, impressions: 40 });
      queryRows = ['resources', 'guides', 'downloads'].flatMap((q) => [
        { query: q, page: 'https://example.com/resources/?type=ebook', impressions: 50 },
        { query: q, page: 'https://example.com/resources/?type=case-study', impressions: 10 },
      ]);
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.evidence.winner, 'https://example.com/resources/?type=ebook');
      assert.equal(result.facts.autoConsolidated, 1);
    });

    test('a query-free URL in the group always wins, even when a query variant earns all the real traffic', async () => {
      // Regression test for a real incident: chayceproperties.com's own
      // homepage "/" got canonicalized onto "/?h=8020347041280" — a legacy
      // tracking-hash URL from a prior site on this domain — purely because
      // that variant happened to have the only recorded GSC impressions.
      // A bare URL must always win over a query-string variant regardless
      // of traffic; traffic-based decisions only apply when NO bare URL
      // exists in the group.
      inventory = [
        { page: 'https://chayceproperties.com/', orphaned: false },
        { page: 'https://chayceproperties.com/?h=8020347041280', orphaned: false },
        { page: 'https://chayceproperties.com/?h=11159752051280', orphaned: false },
      ];
      perfRowsByPage.set('https://chayceproperties.com/?h=8020347041280', { clicks: 0, impressions: 16 });
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.evidence.winner, 'https://chayceproperties.com/');
      assert.equal(finding.recommendedAction.params.canonicalTarget, 'https://chayceproperties.com/');
      assert.equal(result.facts.autoConsolidated, 1);
    });

    test('LOW confidence: no real traffic for any variant, no functional param -> stays reportOnly, undecided', async () => {
      // utm_source is pure tracking noise, so this exercises the true
      // "genuinely no evidence at all" LOW-confidence path, distinct from
      // the functional-param case below.
      inventory = [
        { page: 'https://example.com/resources/?utm_source=newsletter', orphaned: false },
        { page: 'https://example.com/resources/?utm_source=social', orphaned: false },
      ];
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'low');
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.decided, undefined);
    });

    // Regression, confirmed live on Chayce Properties (2026-09-18): 5
    // `/get-started/index.html?package=...` pricing-tier URLs, each a real,
    // distinct service package with no traffic yet (a brand-new page), sat
    // blocked pending a human "pick a winner" decision — but a functional
    // query parameter answers that on its own, with or without traffic; it
    // shouldn't need any to decide "never redirect these away from each
    // other."
    test('a functional query parameter with NO traffic on any variant is still decided leave-both, not left generically blocked', async () => {
      inventory = [
        { page: 'https://example.com/resources/?type=ebook', orphaned: false },
        { page: 'https://example.com/resources/?type=case-study', orphaned: false },
      ];
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.decided, true);
      assert.match(finding.reportOnly.whyBlocked, /functional/);
    });

    test('split-traffic escalation: a non-tracking query parameter is decided leave-both, not punted, even without query overlap', async () => {
      // "type" is not a known tracking parameter, so this is treated as a
      // real functional facet (e.g. selects which resource variant loads) —
      // never consolidated/redirected away.
      inventory = [
        { page: 'https://example.com/resources/?type=ebook', orphaned: false },
        { page: 'https://example.com/resources/?type=case-study', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/resources/?type=ebook', { clicks: 10, impressions: 100 });
      perfRowsByPage.set('https://example.com/resources/?type=case-study', { clicks: 5, impressions: 50 });
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.decided, true);
      assert.match(finding.reportOnly.whyBlocked, /functional/);
    });

    test('split-traffic escalation: different declared page purposes across pure-tracking variants are decided leave-both', async () => {
      // utm_source is pure tracking noise (no functional-param block), so
      // this exercises the page-purpose signal on its own.
      inventory = [
        { page: 'https://example.com/resources/?utm_source=newsletter', orphaned: false },
        { page: 'https://example.com/resources/?utm_source=social', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/resources/?utm_source=newsletter', { clicks: 10, impressions: 100 });
      perfRowsByPage.set('https://example.com/resources/?utm_source=social', { clicks: 5, impressions: 50 });
      contentTypeByPage = (page) => (page.includes('newsletter') ? 'blog' : 'landing');
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.decided, true);
      assert.match(finding.reportOnly.whyBlocked, /different page purposes/);
    });
  });
});
