import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let inventory;
let perfRowsByPage;

mock.module(resolve('../store/read.js'), {
  namedExports: {
    getSiteById: async () => site,
    getSearchPerformanceForPages: async (siteId, start, end, pages) => (
      pages.filter((p) => perfRowsByPage.has(p)).map((p) => ({ dim_value: p, ...perfRowsByPage.get(p) }))
    ),
  },
});
mock.module(resolve('../store/page-inventory.js'), {
  namedExports: { listPageInventory: async () => inventory },
});

const { run } = await import('./query-param-duplicates.js');

beforeEach(() => {
  site = { id: 1, timezone: 'UTC' };
  inventory = [];
  perfRowsByPage = new Map();
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

    test('LOW confidence: no real traffic for any variant -> stays reportOnly', async () => {
      inventory = [
        { page: 'https://example.com/resources/?type=ebook', orphaned: false },
        { page: 'https://example.com/resources/?type=case-study', orphaned: false },
      ];
      const result = await run({ siteId: 1 });
      const finding = result.facts.findings[0];
      assert.equal(finding.evidence.confidence, 'low');
      assert.equal(finding.recommendedAction, null);
    });
  });
});
