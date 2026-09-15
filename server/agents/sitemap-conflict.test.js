import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let site;
let sitemapEntries;
let signalsByPage; // page -> row (or partial)

mock.module(resolve('../store/read.js'), {
  namedExports: { getSiteById: async () => site },
});
mock.module(resolve('./lib/site-discovery.js'), {
  namedExports: { discoverSitemapEntries: async () => sitemapEntries },
});
mock.module(resolve('../store/technical-seo-checks.js'), {
  namedExports: {
    getTechnicalSeoSignalsForPages: async (siteId, { pages }) => pages.map((p) => signalsByPage.get(p)).filter(Boolean),
  },
});

const { run } = await import('./sitemap-conflict.js');

beforeEach(() => {
  site = { id: 1 };
  sitemapEntries = [];
  signalsByPage = new Map();
});

describe('sitemap-conflict agent', () => {
  test('insufficient-data when the sitemap has no entries yet', async () => {
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('insufficient-data when no sitemap URL has been inspected yet', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    const result = await run({ siteId: 1 });
    assert.equal(result.status, 'insufficient-data');
  });

  test('skips a sitemap URL with no index_status yet, rather than guessing', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }, { loc: 'https://example.com/b/' }];
    signalsByPage.set('https://example.com/a/', { page: 'https://example.com/a/', index_status: null });
    signalsByPage.set('https://example.com/b/', { page: 'https://example.com/b/', index_status: { robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: 'https://example.com/b/' } });
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });

  test('flags a sitemap URL blocked by robots.txt', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'DISALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: null },
      last_impressions: 42,
    });
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].reportOnly.kind, 'sitemap-index-conflict');
    assert.equal(result.facts.findings[0].recommendedAction, null);
  });

  test('flags a sitemap URL blocked by a noindex-equivalent indexingState', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'ALLOWED', indexingState: 'BLOCKED_BY_META_TAG', googleCanonical: null },
    });
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
  });

  test('flags a sitemap URL whose Google-chosen canonical points elsewhere', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: 'https://example.com/canonical-a/' },
    });
    const result = await run({ siteId: 1 });
    assert.equal(result.facts.findings.length, 1);
    assert.equal(result.facts.findings[0].id, 'sitemap-conflict:non-canonical:https://example.com/a/');
  });

  test('no finding when robots/indexing are fine and the google canonical matches the URL itself', async () => {
    sitemapEntries = [{ loc: 'https://example.com/a/' }];
    signalsByPage.set('https://example.com/a/', {
      page: 'https://example.com/a/',
      index_status: { robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', googleCanonical: 'https://example.com/a/' },
    });
    const result = await run({ siteId: 1 });
    assert.deepEqual(result.facts.findings, []);
  });
});
