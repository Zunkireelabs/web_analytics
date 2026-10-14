import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let inventory;
let sitemapEntries;
let orphanedPages;
let sitemapOk;
let sitemapReason;
let probeByUrl; // url -> probe result (default: live, self-canonical)
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
  namedExports: { discoverSitemapEntriesChecked: async () => ({ ok: sitemapOk, entries: sitemapEntries, reason: sitemapReason }) },
});
mock.module(resolve('./lib/live-probe.js'), {
  namedExports: {
    probeMany: async (urls, { maxProbes = 40 } = {}) => ({
      results: urls.slice(0, maxProbes).map((u) => probeByUrl.get(u) || { url: u, verdict: 'live', status: 200, canonical: null }),
      skipped: urls.slice(maxProbes),
    }),
    isSelfCanonical: (p) => !p.canonical || p.canonical === p.url,
    normalizeUrlForCompare: (u) => u,
  },
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
  sitemapOk = true;
  sitemapReason = null;
  probeByUrl = new Map();
  sitemapEntries = [{ loc: 'https://example.com/' }];
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
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.missingUrls, ['https://example.com/new-page/']);
  });

  test('loop-prevention: never re-flags a URL Google confirms is currently blocked/excluded', async () => {
    inventory = [{ page: 'https://example.com/blocked-page/' }, { page: 'https://example.com/real-new-page/' }];
    signalsByPage.set('https://example.com/blocked-page/', { robotsTxtState: 'DISALLOWED', indexingState: 'INDEXING_ALLOWED' });
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.missingUrls, ['https://example.com/real-new-page/']);
  });

  test('a URL with no index_status signal at all is still treated as genuinely missing', async () => {
    inventory = [{ page: 'https://example.com/never-checked/' }];
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.missingUrls, ['https://example.com/never-checked/']);
  });

  test('insufficient-data (never "everything missing") when the sitemap fetch failed or came back empty', async () => {
    inventory = [{ page: 'https://example.com/a/' }, { page: 'https://example.com/b/' }];
    sitemapOk = false;
    sitemapEntries = [];
    sitemapReason = 'one or more sitemap files could not be fetched';
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('drops 404s, redirects, query variants, other hosts and non-self-canonical pages — only live 200s count', async () => {
    inventory = [
      { page: 'https://example.com/real/' },
      { page: 'https://example.com/gone/' },
      { page: 'https://example.com/old/' },
      { page: 'https://example.com/shop/?color=red' },
      { page: 'https://www.example.com/real/' },
      { page: 'https://example.com/alias/' },
    ];
    probeByUrl.set('https://example.com/gone/', { url: 'https://example.com/gone/', verdict: 'dead', status: 404 });
    probeByUrl.set('https://example.com/old/', { url: 'https://example.com/old/', verdict: 'redirect', status: 301 });
    probeByUrl.set('https://example.com/alias/', { url: 'https://example.com/alias/', verdict: 'live', status: 200, canonical: 'https://example.com/real/' });
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.missingUrls, ['https://example.com/real/']);
    assert.equal(result.facts.findings[0].verification.verdict, 'confirmed');
  });

  test('an unverifiable probe is never asserted as missing', async () => {
    inventory = [{ page: 'https://example.com/blocked/' }];
    probeByUrl.set('https://example.com/blocked/', { url: 'https://example.com/blocked/', verdict: 'unverifiable', status: 403 });
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.missingUrls, []);
    assert.equal(result.facts.unverifiableCount, 1);
  });
});
