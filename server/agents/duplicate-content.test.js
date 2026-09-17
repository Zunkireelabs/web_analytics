import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const resolve = (p) => new URL(p, import.meta.url).href;

let knownHashes; // what past runs already recorded for this site
// Per-page traffic override for the confidence-gated evidence tests below —
// any page NOT in this map falls back to the flat impressions:100 every
// pre-existing test in this file was already written against, so adding
// this override capability changes no existing test's outcome.
let perfRowsByPage;
let queryRows; // [{query, page, impressions}] — for the medium->high query-overlap escalation

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSearchPerformanceForPages: async (siteId, start, end, pages) =>
      pages.map((p) => ({ dim_value: p, ...(perfRowsByPage.get(p) || { impressions: 100 }) })),
    getSiteById: async () => ({ id: 1, timezone: 'UTC' }),
    getQueryPageMetrics: async () => queryRows,
  },
});
mock.module(resolve('../store/page-inventory.js'), {
  namedExports: {
    updatePageContentHashBatch: async () => {},
    listContentHashesForSite: async () => knownHashes,
  },
});
mock.module(resolve('./lib/candidate-pages.js'), {
  namedExports: { selectCandidatePages: async () => ({ batch: [], impressionsByPage: new Map() }), markPagesChecked: async () => {} },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});
// Defaults to "unclassified" (null) so every pre-existing test's split-
// traffic MEDIUM outcome is unaffected — a page-purpose signal that isn't
// available must never be treated as "purposes differ." Individual tests
// override contentTypeByPage to exercise the new escalation path.
let contentTypeByPage = null;
mock.module(resolve('./lib/page-content-classifier.js'), {
  namedExports: {
    getOrClassifyPageContentType: async (siteId, page) => {
      const type = typeof contentTypeByPage === 'function' ? contentTypeByPage(page) : contentTypeByPage;
      return type ? { contentType: type, confidence: 0.9, classifiedBy: 'path' } : null;
    },
  },
});

const { run } = await import('./duplicate-content.js');

const DUPLICATE_BODY = 'the same real body content served at more than one url';
const pageCache = async (page) => ({
  ok: true,
  analysis: { wordCount: 900, bodyText: page.includes('unique') ? `unique ${page}` : DUPLICATE_BODY },
});

const runOn = (pages) => run({ siteId: 1, start: '2026-08-01', end: '2026-08-28', pageCache, params: { pages } });

beforeEach(() => { knownHashes = []; perfRowsByPage = new Map(); queryRows = []; contentTypeByPage = null; });

describe('duplicate-content finding ids', () => {
  // The bug: the id was keyed on the alphabetically-first page in the group,
  // so discovering one more URL serving the same content re-issued the SAME
  // unresolved duplication under a brand-new id — a "new" finding, a broken
  // match against the already-open recommendation, and a lost history.
  test('the id is stable when another duplicate page joins the group', async () => {
    const first = await runOn(['https://example.com/b', 'https://example.com/c']);
    assert.equal(first.facts.findings.length, 1);
    const originalId = first.facts.findings[0].id;
    assert.equal(first.facts.findings[0].evidence.pages.length, 2);

    // A later run finds a third URL that sorts BEFORE the old anchor page.
    knownHashes = first.facts.findings[0].evidence.pages.map((page) => ({
      page, content_hash: first.facts.findings[0].evidence.contentHash,
    }));
    const second = await runOn(['https://example.com/a']);
    assert.equal(second.facts.findings.length, 1);
    assert.equal(second.facts.findings[0].evidence.pages.length, 3);
    assert.equal(second.facts.findings[0].id, originalId, 'the same unresolved duplication must keep its identity');
  });

  test('the id is stable when a page leaves the group too', async () => {
    knownHashes = [];
    const three = await runOn(['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
    const idOfThree = three.facts.findings[0].id;

    const two = await runOn(['https://example.com/b', 'https://example.com/c']);
    assert.equal(two.facts.findings[0].id, idOfThree);
  });

  test('genuinely different duplicate groups never collide on one id', async () => {
    const other = async (page) => ({
      ok: true,
      analysis: { wordCount: 900, bodyText: page.startsWith('https://example.com/x') ? 'group one body' : 'group two body' },
    });
    const result = await run({
      siteId: 1, start: '2026-08-01', end: '2026-08-28', pageCache: other,
      params: { pages: ['https://example.com/x1', 'https://example.com/x2', 'https://example.com/y1', 'https://example.com/y2'] },
    });
    assert.equal(result.facts.findings.length, 2);
    assert.equal(new Set(result.facts.findings.map((f) => f.id)).size, 2);
  });

  test('a page that is not a duplicate produces no finding at all', async () => {
    const result = await runOn(['https://example.com/unique-1', 'https://example.com/unique-2']);
    assert.equal(result.facts.findings.length, 0);
  });

  test('evidence pages are sorted, so the same group renders identically run to run', async () => {
    const result = await runOn(['https://example.com/c', 'https://example.com/a', 'https://example.com/b']);
    assert.deepEqual(result.facts.findings[0].evidence.pages, [
      'https://example.com/a', 'https://example.com/b', 'https://example.com/c',
    ]);
  });

  // Until 2026-09-09 this finding had a null recommendedAction and no
  // reportOnly, which is precisely the shape buildRecommendations discards —
  // so byte-identical duplicate pages were detected every run and surfaced to
  // nobody, despite duplicate-content being listed in RECOMMENDATION_AGENT_IDS.
  test('surfaces the group as a visible report-only row rather than being dropped', async () => {
    const result = await runOn(['https://example.com/c', 'https://example.com/a', 'https://example.com/b']);
    const ro = result.facts.findings[0].reportOnly;

    assert.equal(ro.kind, 'duplicate-content');
    // Points at a real member page, and at a stable one (sorted), so the row's
    // (page, kind) dedup key does not move between runs.
    assert.equal(ro.page, 'https://example.com/a');
    assert.match(ro.whyBlocked, /needs a person who knows which page is the intended one/);
  });

  test('still refuses to pick a canonical URL automatically when evidence is only equal, unconfirmed impressions', async () => {
    const result = await runOn(['https://example.com/a', 'https://example.com/b']);
    // Both pages get the flat impressions:100 default — real traffic on
    // both sides, no query-overlap evidence available (empty queryRows), so
    // this must stay MEDIUM confidence and never guess a winner.
    assert.equal(result.facts.findings[0].recommendedAction, null);
  });

  describe('confidence-gated evidence (decideWinner)', () => {
    test('HIGH confidence: exactly one page has all the real traffic, the other none -> auto-drafts a canonical consolidation', async () => {
      perfRowsByPage.set('https://example.com/a', { clicks: 0, impressions: 0 });
      perfRowsByPage.set('https://example.com/b', { clicks: 40, impressions: 300 });
      const result = await runOn(['https://example.com/a', 'https://example.com/b']);
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.evidence.winner, 'https://example.com/b');
      assert.equal(finding.recommendedAction.generatorId, 'canonical');
      assert.deepEqual(finding.recommendedAction.params, { page: 'https://example.com/a', canonicalTarget: 'https://example.com/b' });
      assert.equal(finding.reportOnly, null);
    });

    test('MEDIUM escalates to HIGH when query sets overlap substantially and one page has strictly more clicks', async () => {
      perfRowsByPage.set('https://example.com/a', { clicks: 5, impressions: 50 });
      perfRowsByPage.set('https://example.com/b', { clicks: 90, impressions: 900 });
      queryRows = ['company', 'contact us', 'about page'].flatMap((q) => [
        { query: q, page: 'https://example.com/b', impressions: 50 },
        { query: q, page: 'https://example.com/a', impressions: 10 },
      ]);
      const result = await runOn(['https://example.com/a', 'https://example.com/b']);
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.evidence.winner, 'https://example.com/b');
      assert.equal(finding.evidence.queryOverlap.overlapping, true);
      assert.equal(finding.recommendedAction.generatorId, 'canonical');
    });

    test('MEDIUM stays MEDIUM when query sets do not overlap, even with a large traffic gap', async () => {
      perfRowsByPage.set('https://example.com/a', { clicks: 5, impressions: 50 });
      perfRowsByPage.set('https://example.com/b', { clicks: 90, impressions: 900 });
      queryRows = [
        { query: 'our company', page: 'https://example.com/b', impressions: 50 },
        { query: 'unrelated term', page: 'https://example.com/a', impressions: 10 },
      ];
      const result = await runOn(['https://example.com/a', 'https://example.com/b']);
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'medium');
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.kind, 'duplicate-content');
    });

    test('split-traffic escalation: a functional (non-tracking) query parameter blocks consolidation, decided as leave-both rather than punted', async () => {
      perfRowsByPage.set('https://example.com/a?package=gold', { clicks: 5, impressions: 50 });
      perfRowsByPage.set('https://example.com/b', { clicks: 90, impressions: 900 });
      queryRows = [
        { query: 'our company', page: 'https://example.com/b', impressions: 50 },
        { query: 'unrelated term', page: 'https://example.com/a?package=gold', impressions: 10 },
      ];
      const result = await runOn(['https://example.com/a?package=gold', 'https://example.com/b']);
      const finding = result.facts.findings[0];
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.decided, true);
      assert.match(finding.reportOnly.whyBlocked, /functional/);
    });

    test('split-traffic escalation: genuinely different declared page purposes are decided as leave-both, not merged', async () => {
      perfRowsByPage.set('https://example.com/a', { clicks: 5, impressions: 50 });
      perfRowsByPage.set('https://example.com/b', { clicks: 90, impressions: 900 });
      queryRows = [
        { query: 'our company', page: 'https://example.com/b', impressions: 50 },
        { query: 'unrelated term', page: 'https://example.com/a', impressions: 10 },
      ];
      contentTypeByPage = (page) => (page.endsWith('/a') ? 'blog' : 'product');
      const result = await runOn(['https://example.com/a', 'https://example.com/b']);
      const finding = result.facts.findings[0];
      assert.equal(finding.recommendedAction, null);
      assert.equal(finding.reportOnly.decided, true);
      assert.match(finding.reportOnly.whyBlocked, /different page purposes/);
    });

    test('split-traffic escalation: canonical tag agreement wins outright, even without query overlap', async () => {
      const cache = async (page) => ({
        ok: true,
        analysis: {
          wordCount: 900,
          bodyText: DUPLICATE_BODY,
          hasCanonical: page === 'https://example.com/a',
          canonicalUrl: 'https://example.com/b', // every OTHER page already points here
        },
      });
      perfRowsByPage.set('https://example.com/a', { clicks: 5, impressions: 50 });
      perfRowsByPage.set('https://example.com/b', { clicks: 3, impressions: 30 });
      const result = await run({
        siteId: 1, start: '2026-08-01', end: '2026-08-28', pageCache: cache,
        params: { pages: ['https://example.com/a', 'https://example.com/b'] },
      });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.evidence.winner, 'https://example.com/b');
      assert.equal(finding.recommendedAction.generatorId, 'canonical');
    });
  });
});

// Regression coverage for a real false positive found in production
// (zunkireelabs.com, 2026-09-12): query-string tracking variants
// (/resources/?type=X) already emitted a self-resolving canonical tag to the
// bare URL via the shared Eleventy template, so the duplicate-content agent
// was flagging (and blocking for a human "pick a winner" decision) a group
// the site had already resolved for search engines itself.
describe('duplicate-content — groups already resolved via an existing canonical tag', () => {
  test('no finding at all when every member already canonicalizes to one page in the group', async () => {
    const cache = async (page) => ({
      ok: true,
      analysis: {
        wordCount: 900,
        bodyText: DUPLICATE_BODY,
        hasCanonical: true,
        canonicalUrl: 'https://example.com/resources/',
      },
    });
    const result = await run({
      siteId: 1, start: '2026-08-01', end: '2026-08-28', pageCache: cache,
      params: { pages: ['https://example.com/resources/?type=a', 'https://example.com/resources/?type=b'] },
    });
    assert.equal(result.facts.findings.length, 0);
  });

  test('still flags the group when canonical tags disagree on the target', async () => {
    const cache = async (page) => ({
      ok: true,
      analysis: {
        wordCount: 900,
        bodyText: DUPLICATE_BODY,
        hasCanonical: true,
        // Each page canonicalizes to itself — no consensus target.
        canonicalUrl: page,
      },
    });
    const result = await run({
      siteId: 1, start: '2026-08-01', end: '2026-08-28', pageCache: cache,
      params: { pages: ['https://example.com/resources/?type=a', 'https://example.com/resources/?type=b'] },
    });
    assert.equal(result.facts.findings.length, 1);
  });

  test('still flags the group when no member has a canonical tag at all', async () => {
    const cache = async () => ({
      ok: true,
      analysis: { wordCount: 900, bodyText: DUPLICATE_BODY, hasCanonical: false, canonicalUrl: null },
    });
    const result = await run({
      siteId: 1, start: '2026-08-01', end: '2026-08-28', pageCache: cache,
      params: { pages: ['https://example.com/resources/?type=a', 'https://example.com/resources/?type=b'] },
    });
    assert.equal(result.facts.findings.length, 1);
  });
});
