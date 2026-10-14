import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let dataForSeoConfigured;
let dataForSeoSummaries; // domain -> summary object, or a rejecting error
let commonCrawlSummaries; // domain -> summary object, or null

mock.module(resolve('../../ingest/dataforseo-backlinks.js'), {
  namedExports: {
    configured: () => dataForSeoConfigured,
    fetchBacklinkSummary: async (domain) => {
      const entry = dataForSeoSummaries[domain];
      if (entry instanceof Error) throw entry;
      return entry ?? null;
    },
  },
});
mock.module(resolve('../../providers/backlinks/commoncrawl.js'), {
  namedExports: {
    fetchDomainSummary: async (domain) => commonCrawlSummaries[domain] ?? null,
  },
});

const { buildBacklinkComparison } = await import('./competitor-backlinks.js');

describe('buildBacklinkComparison — DataForSEO preferred, Common Crawl fallback', () => {
  test('uses real DataForSEO data for every domain when configured and it succeeds', async () => {
    dataForSeoConfigured = true;
    dataForSeoSummaries = {
      'own.com': { referringDomains: 40, referringIps: 30 },
      'rival.com': { referringDomains: 90, referringIps: 60 },
    };
    commonCrawlSummaries = {};

    const result = await buildBacklinkComparison('own.com', ['rival.com']);
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'dataforseo');
    assert.equal(result.ownDomain.source, 'dataforseo');
    assert.equal(result.competitors[0].source, 'dataforseo');
    assert.equal(result.largestGap.domain, 'rival.com');
    assert.equal(result.largestGap.gap, 50);
  });

  test('falls back to Common Crawl for a domain DataForSEO could not resolve, even when configured', async () => {
    dataForSeoConfigured = true;
    dataForSeoSummaries = {
      'own.com': { referringDomains: 40 },
      'rival.com': new Error('DataForSEO task error: domain not found'),
    };
    commonCrawlSummaries = {
      'rival.com': { referringDomains: 15, graphRank: 500, graphRelease: 'CC-MAIN-2026-01', updatedAt: '2026-01-01' },
    };

    const result = await buildBacklinkComparison('own.com', ['rival.com']);
    assert.equal(result.status, 'ok');
    assert.equal(result.ownDomain.source, 'dataforseo');
    assert.equal(result.competitors[0].source, 'commoncrawl');
    assert.equal(result.competitors[0].referringDomains, 15);
  });

  test('uses Common Crawl for every domain when DataForSEO is not configured — unchanged prior behavior', async () => {
    dataForSeoConfigured = false;
    dataForSeoSummaries = {};
    commonCrawlSummaries = {
      'own.com': { referringDomains: 10, graphRank: 900, graphRelease: 'CC-MAIN-2026-01', updatedAt: '2026-01-01' },
      'rival.com': { referringDomains: 20, graphRank: 400, graphRelease: 'CC-MAIN-2026-01', updatedAt: '2026-01-01' },
    };

    const result = await buildBacklinkComparison('own.com', ['rival.com']);
    assert.equal(result.status, 'ok');
    assert.equal(result.source, 'commoncrawl');
    assert.equal(result.ownDomain.source, 'commoncrawl');
    assert.equal(result.competitors[0].source, 'commoncrawl');
  });

  test('reports insufficient-data, never fabricated, when neither source has the own domain', async () => {
    dataForSeoConfigured = true;
    dataForSeoSummaries = { 'rival.com': { referringDomains: 90 } };
    commonCrawlSummaries = {};

    const result = await buildBacklinkComparison('own.com', ['rival.com']);
    assert.equal(result.status, 'insufficient-data');
    assert.equal(result.source, 'dataforseo');
    assert.match(result.message, /own domain has no real referring-domain data/);
  });
});
