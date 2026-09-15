import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let inventory;
let contentTypeByPage; // page -> contentType string, or a function(page) => contentType
let perfRowsByPage; // page -> {clicks, impressions}
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
mock.module(resolve('./lib/page-content-classifier.js'), {
  namedExports: {
    getOrClassifyPageContentType: async (siteId, page) => {
      const type = typeof contentTypeByPage === 'function' ? contentTypeByPage(page) : contentTypeByPage;
      return type ? { contentType: type, confidence: 0.9, classifiedBy: 'path' } : null;
    },
  },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});

const { run } = await import('./templated-duplicates.js');

const LOCATION_PATTERN = { match: '^/locations/([^/]+)/([^/]+)/?$' };
const OLD_ENOUGH = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(); // well past the 90-day evidence window
const TOO_NEW = new Date().toISOString();

function pagesFor(pattern, count, { base = 'https://example.com', firstSeenAt = OLD_ENOUGH } = {}) {
  return Array.from({ length: count }, (_, i) => ({ page: `${base}/locations/city${i}/service${i}/`, orphaned: false, first_seen_at: firstSeenAt }));
}

beforeEach(() => {
  site = { id: 1, timezone: 'UTC', url_file_map: { patterns: [LOCATION_PATTERN] } };
  inventory = [];
  contentTypeByPage = 'service';
  perfRowsByPage = new Map();
  queryRows = [];
});

describe('templated-duplicates agent', () => {
  test('insufficient-data when the site has no url_file_map.patterns', async () => {
    site = { id: 1, url_file_map: {} };
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('ok, no finding, when a matched group is smaller than the size floor', async () => {
    inventory = pagesFor(LOCATION_PATTERN, 3);
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.facts.findings, []);
  });

  test('flags a large templated family with no traffic evidence as reportOnly (low confidence)', async () => {
    inventory = pagesFor(LOCATION_PATTERN, 10);
    contentTypeByPage = 'service';
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].evidence.pageCount, 10);
    assert.equal(result.facts.findings[0].evidence.confidence, 'low');
    assert.equal(result.facts.findings[0].reportOnly.kind, 'templated-duplicate-family');
    assert.equal(result.facts.findings[0].recommendedAction, null);
  });

  test('never flags blog content, even at large group size — expected to be genuinely unique', async () => {
    inventory = pagesFor(LOCATION_PATTERN, 20);
    contentTypeByPage = 'blog';
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  test('skips a group with mixed content types rather than guessing', async () => {
    inventory = pagesFor(LOCATION_PATTERN, 10);
    let i = 0;
    contentTypeByPage = () => (i++ % 2 === 0 ? 'service' : 'landing');
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  test('orphaned inventory rows are excluded from grouping', async () => {
    inventory = pagesFor(LOCATION_PATTERN, 10).map((r, i) => (i < 5 ? { ...r, orphaned: true } : r));
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []); // only 5 live pages left, below MIN_GROUP_SIZE
  });

  describe('confidence-gated evidence', () => {
    test('HIGH confidence: exactly one old-enough member earns all the real traffic, every other old-enough member earns none -> auto-consolidates', async () => {
      inventory = pagesFor(LOCATION_PATTERN, 8);
      perfRowsByPage.set(inventory[0].page, { clicks: 15, impressions: 200 });
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.evidence.winner, inventory[0].page);
      assert.equal(finding.recommendedAction.generatorId, 'canonical');
      assert.equal(finding.recommendedAction.params.canonicalTarget, inventory[0].page);
      assert.notEqual(finding.recommendedAction.params.page, inventory[0].page);
      assert.equal(result.facts.autoConsolidated, 1);
    });

    test('MEDIUM confidence: two members earn real traffic independently -> stays reportOnly, never guesses a winner', async () => {
      inventory = pagesFor(LOCATION_PATTERN, 8);
      perfRowsByPage.set(inventory[0].page, { clicks: 15, impressions: 200 });
      perfRowsByPage.set(inventory[1].page, { clicks: 3, impressions: 40 });
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'medium');
      assert.equal(finding.recommendedAction, null);
    });

    test('MEDIUM escalates to HIGH when query sets overlap substantially across every eligible member with real traffic', async () => {
      inventory = pagesFor(LOCATION_PATTERN, 8);
      perfRowsByPage.set(inventory[0].page, { clicks: 30, impressions: 300 });
      perfRowsByPage.set(inventory[1].page, { clicks: 4, impressions: 40 });
      queryRows = ['ai development', 'software company'].flatMap((q) => [
        { query: q, page: inventory[0].page, impressions: 50 },
        { query: q, page: inventory[1].page, impressions: 10 },
      ]);
      // three shared queries minimum required by duplicate-evidence.js —
      // add one more shared term.
      queryRows.push({ query: 'custom software', page: inventory[0].page, impressions: 20 });
      queryRows.push({ query: 'custom software', page: inventory[1].page, impressions: 5 });
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'high');
      assert.equal(finding.evidence.winner, inventory[0].page);
      assert.equal(result.facts.autoConsolidated, 1);
    });

    test('a family mostly too young for evidence never auto-consolidates, even if the few eligible members look clean', async () => {
      const old = pagesFor(LOCATION_PATTERN, 2, { firstSeenAt: OLD_ENOUGH });
      const young = pagesFor(LOCATION_PATTERN, 6, { firstSeenAt: TOO_NEW }).map((r, i) => ({ ...r, page: `https://example.com/locations/newcity${i}/newservice${i}/` }));
      inventory = [...old, ...young];
      perfRowsByPage.set(old[0].page, { clicks: 10, impressions: 100 });
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.notEqual(finding.evidence.confidence, 'high');
      assert.equal(finding.recommendedAction, null);
    });
  });
});
