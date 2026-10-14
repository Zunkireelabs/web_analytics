import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let inventory;
let perfRowsByPage; // page -> {clicks, impressions} — absent means zero real traffic
let queryRows; // [{query, page, impressions}] — for the medium->high query-overlap escalation

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
      classifierCalls++;
      const type = typeof contentTypeByPage === 'function' ? contentTypeByPage(page) : contentTypeByPage;
      return type ? { contentType: type, confidence: 0.9, classifiedBy: 'path' } : null;
    },
  },
});

// Live probe: default every variant to a live, self-canonical 200 so the
// pre-existing grouping/evidence tests are unchanged; individual tests
// override probeByUrl to model redirects/404s/canonicals.
let probeByUrl = new Map();
let classifierCalls = 0;
mock.module(resolve('./lib/live-probe.js'), {
  namedExports: {
    createVariantProber: () => async (pages) => new Map(pages.map((p) => [p, probeByUrl.get(p) || { url: p, verdict: 'live', status: 200, canonical: null }])),
    isSelfCanonical: (p) => !p.canonical || p.canonical === p.url,
    normalizeUrlForCompare: (u) => String(u),
  },
});

const { run } = await import('./url-variant-duplicates.js');

beforeEach(() => {
  probeByUrl = new Map();
  classifierCalls = 0;
  site = { id: 1, timezone: 'UTC' };
  inventory = [];
  perfRowsByPage = new Map();
  queryRows = [];
  contentTypeByPage = null;
});

describe('url-variant-duplicates agent', () => {
  test('insufficient-data when the site has no inventory yet', async () => {
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('ok, no finding, when every page is already unique after normalization', async () => {
    inventory = [
      { page: 'https://example.com/', orphaned: false },
      { page: 'https://example.com/about/', orphaned: false },
      { page: 'https://example.com/blog/post-1/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  test('flags a trailing-slash duplicate pair', async () => {
    inventory = [
      { page: 'https://example.com/about', orphaned: false },
      { page: 'https://example.com/about/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
    assert.deepEqual(result.facts.findings[0].evidence.variants, ['https://example.com/about', 'https://example.com/about/']);
  });

  test('flags a case-variant duplicate pair', async () => {
    inventory = [
      { page: 'https://example.com/Pricing/', orphaned: false },
      { page: 'https://example.com/pricing/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
  });

  test('flags a percent-encoding duplicate pair', async () => {
    inventory = [
      { page: 'https://example.com/caf%C3%A9/', orphaned: false },
      { page: 'https://example.com/café/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
  });

  test('orphaned rows are excluded from grouping', async () => {
    inventory = [
      { page: 'https://example.com/about', orphaned: true },
      { page: 'https://example.com/about/', orphaned: false },
    ];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  describe('confidence-gated evidence', () => {
    test('HIGH confidence: exactly one variant has all the real traffic, the other none -> auto-drafts a canonical consolidation', async () => {
      inventory = [
        { page: 'https://example.com/about', orphaned: false },
        { page: 'https://example.com/about/', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/about/', { clicks: 40, impressions: 300 });
      // https://example.com/about has NO row at all -> zero real traffic
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.evidence.winner, 'https://example.com/about/');
      assert.equal(finding.recommendedAction.generatorId, 'canonical');
      assert.deepEqual(finding.recommendedAction.params, { page: 'https://example.com/about', canonicalTarget: 'https://example.com/about/' });
      assert.equal(finding.reportOnly, null);
      assert.equal(result.facts.autoConsolidated, 1);
    });

    test('MEDIUM confidence: two variants both show real traffic -> stays reportOnly, never guesses a winner from a bigger share', async () => {
      inventory = [
        { page: 'https://example.com/about', orphaned: false },
        { page: 'https://example.com/about/', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/about/', { clicks: 90, impressions: 900 });
      perfRowsByPage.set('https://example.com/about', { clicks: 1, impressions: 5 }); // small but real and nonzero
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'medium');
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.kind, 'url-variant-duplicate');
    });

    test('MEDIUM escalates to HIGH when query sets overlap substantially and one variant has strictly more clicks', async () => {
      inventory = [
        { page: 'https://example.com/about', orphaned: false },
        { page: 'https://example.com/about/', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/about/', { clicks: 90, impressions: 900 });
      perfRowsByPage.set('https://example.com/about', { clicks: 5, impressions: 50 });
      queryRows = ['company', 'contact us', 'about page'].flatMap((q) => [
        { query: q, page: 'https://example.com/about/', impressions: 50 },
        { query: q, page: 'https://example.com/about', impressions: 10 },
      ]);
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.evidence.winner, 'https://example.com/about/');
      assert.equal(finding.evidence.queryOverlap.overlapping, true);
      assert.equal(finding.recommendedAction.generatorId, 'canonical');
      assert.equal(result.facts.autoConsolidated, 1);
    });

    test('MEDIUM stays MEDIUM when query sets do not overlap, even with a large traffic gap', async () => {
      inventory = [
        { page: 'https://example.com/about', orphaned: false },
        { page: 'https://example.com/about/', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/about/', { clicks: 90, impressions: 900 });
      perfRowsByPage.set('https://example.com/about', { clicks: 5, impressions: 50 });
      queryRows = [
        { query: 'our company', page: 'https://example.com/about/', impressions: 50 },
        { query: 'unrelated term', page: 'https://example.com/about', impressions: 10 },
      ];
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'medium');
      assert.equal(finding.recommendedAction, null);
    });

    test('LOW confidence: no real traffic evidence for any variant -> stays reportOnly', async () => {
      inventory = [
        { page: 'https://example.com/about', orphaned: false },
        { page: 'https://example.com/about/', orphaned: false },
      ];
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'low');
      assert.equal(finding.recommendedAction, null);
    });

    test('split-traffic escalation: a functional (non-tracking) query parameter blocks consolidation and is decided leave-both', async () => {
      // normalizeKey groups by hostname+pathname only, so a group here can
      // include a query-string variant carrying a real functional param.
      inventory = [
        { page: 'https://example.com/get-started?package=gold', orphaned: false },
        { page: 'https://example.com/get-started', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/get-started?package=gold', { clicks: 5, impressions: 50 });
      perfRowsByPage.set('https://example.com/get-started', { clicks: 90, impressions: 900 });
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.decided, true);
      assert.match(finding.reportOnly.whyBlocked, /functional/);
    });

    test('split-traffic escalation: different declared page purposes are decided leave-both', async () => {
      inventory = [
        { page: 'https://example.com/about', orphaned: false },
        { page: 'https://example.com/about/', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/about/', { clicks: 90, impressions: 900 });
      perfRowsByPage.set('https://example.com/about', { clicks: 5, impressions: 50 });
      contentTypeByPage = (page) => (page.endsWith('/') ? 'landing' : 'blog');
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.decided, true);
      assert.match(finding.reportOnly.whyBlocked, /different page purposes/);
    });

    test('a group with 3+ variants and only one bearing traffic still auto-consolidates every loser onto the same winner', async () => {
      inventory = [
        { page: 'https://example.com/about', orphaned: false },
        { page: 'https://example.com/About/', orphaned: false },
        { page: 'https://example.com/about/', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/about/', { clicks: 10, impressions: 100 });
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.recommendedAction.params.canonicalTarget, 'https://example.com/about/');
      // Only ONE loser goes in this finding's recommendedAction (one
      // recommendation = one drafted PR target) — the other loser is still
      // named in evidence.variants for a human/future run to see.
      assert.notEqual(finding.recommendedAction.params.page, 'https://example.com/about/');
    });
  });

  describe('live verification', () => {
    const dup = () => {
      inventory = [
        { page: 'https://example.com/about', orphaned: false },
        { page: 'https://example.com/about/', orphaned: false },
      ];
      perfRowsByPage.set('https://example.com/about/', { clicks: 10, impressions: 100 });
    };

    test('a variant that 301s to its sibling is not a live duplicate -> no finding', async () => {
      dup();
      probeByUrl.set('https://example.com/about', { url: 'https://example.com/about', verdict: 'redirect', status: 301, redirectsTo: 'https://example.com/about/' });
      const result = await run({ siteId: 1 });
      assert.deepEqual(result.facts.findings, []);
      assert.equal(result.facts.droppedGroups, 1);
    });

    test('an unverifiable probe withholds the group entirely', async () => {
      dup();
      probeByUrl.set('https://example.com/about', { url: 'https://example.com/about', verdict: 'unverifiable', status: 403 });
      const result = await run({ siteId: 1 });
      assert.deepEqual(result.facts.findings, []);
      assert.equal(result.facts.unverifiableGroups, 1);
    });

    test('a loser whose canonical already equals the winner needs no action', async () => {
      dup();
      probeByUrl.set('https://example.com/about', { url: 'https://example.com/about', verdict: 'live', status: 200, canonical: 'https://example.com/about/' });
      const result = await run({ siteId: 1 });
      assert.deepEqual(result.facts.findings, []);
    });

    test('a confirmed finding carries a confirmed verification', async () => {
      dup();
      const result = await run({ siteId: 1 });
      assert.equal(result.facts.findings[0].verification.verdict, 'confirmed');
    });

    test('dryRun never touches the classifier (no cache write / LLM call)', async () => {
      dup();
      await run({ siteId: 1, dryRun: true });
      assert.equal(classifierCalls, 0);
      await run({ siteId: 1 });
      assert.ok(classifierCalls > 0);
    });
  });
});
