import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let inventory;
let contentTypeByPage; // page -> contentType string, or a function(page) => contentType

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => site },
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

function pagesFor(pattern, count, base = 'https://example.com') {
  return Array.from({ length: count }, (_, i) => ({ page: `${base}/locations/city${i}/service${i}/`, orphaned: false }));
}

beforeEach(() => {
  site = { id: 1, url_file_map: { patterns: [LOCATION_PATTERN] } };
  inventory = [];
  contentTypeByPage = 'service';
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

  test('flags a large templated family that classifies consistently as a non-excluded content type', async () => {
    inventory = pagesFor(LOCATION_PATTERN, 10);
    contentTypeByPage = 'service';
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].evidence.pageCount, 10);
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
});
