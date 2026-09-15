import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let inventory;
let sitemapEntries;
let orphanedPages;
let signalsByPage; // page -> index_status (or undefined = never checked)

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});
mock.module(resolve('../store/page-inventory.js'), {
  namedExports: {
    listPageInventory: async () => inventory,
    listOrphanedPages: async () => orphanedPages,
  },
});
mock.module(resolve('./lib/site-discovery.js'), {
  namedExports: { discoverSitemapEntries: async () => sitemapEntries },
});
mock.module(resolve('../store/technical-seo-checks.js'), {
  namedExports: {
    getTechnicalSeoSignalsForPages: async (siteId, { pages }) => (
      pages.filter((p) => signalsByPage.has(p)).map((p) => ({ page: p, index_status: signalsByPage.get(p) }))
    ),
  },
});
mock.module(resolve('../llm.js'), {
  namedExports: { callLLM: async () => 'narrative' },
});

const { run } = await import('./sitemap.js');

beforeEach(() => {
  site = { id: 1, url_file_map: { siteRoot: { sitemap: 'src/sitemap.njk' } } };
  inventory = [];
  sitemapEntries = [];
  orphanedPages = [];
  signalsByPage = new Map();
});

describe('sitemap agent', () => {
  test('insufficient-data when no sitemap is mapped', async () => {
    site = { id: 1, url_file_map: {} };
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('flags a real page missing from the sitemap', async () => {
    inventory = [{ page: 'https://example.com/new-page/' }];
    sitemapEntries = [];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.missingUrls, ['https://example.com/new-page/']);
  });

  test('loop-prevention: never re-flags a URL Google confirms is currently blocked/excluded', async () => {
    inventory = [{ page: 'https://example.com/blocked-page/' }, { page: 'https://example.com/real-new-page/' }];
    sitemapEntries = [];
    signalsByPage.set('https://example.com/blocked-page/', { robotsTxtState: 'DISALLOWED', indexingState: 'INDEXING_ALLOWED' });
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.missingUrls, ['https://example.com/real-new-page/']);
  });

  test('a URL with no index_status signal at all is still treated as genuinely missing', async () => {
    inventory = [{ page: 'https://example.com/never-checked/' }];
    sitemapEntries = [];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.missingUrls, ['https://example.com/never-checked/']);
  });
});
