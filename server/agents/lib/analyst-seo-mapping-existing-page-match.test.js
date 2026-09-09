import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

// findExistingPageMatch (analyst-seo-mapping.js) checks whether a real
// existing page already covers a keyword-gap topic — page_inventory (crawl/
// sitemap-discovered) carries no domain filtering of its own, so without an
// explicit check here a topic could get matched against a real page on a
// registered-but-separate additional_own_domain (edgex./zenly.zunkireelabs.com)
// or a foreign hostname entirely (gap confirmed 2026-08-24, same class as
// seoDraftEligibility's own domain-scoping fix in the same file).

let site;
let inventoryPages; // [{ page: url }]
let fetchedPages; // tracks which page URLs analyzePageUrl was actually called for
let coveredByAnswer; // what the mocked LLM call returns

const realRead = await import(resolve('../../store/read.js'));
mock.module(resolve('../../store/read.js'), {
  namedExports: { ...realRead, getSiteById: async () => site },
});
mock.module(resolve('../../store/page-inventory.js'), {
  namedExports: { listPageInventory: async () => inventoryPages },
});
// Deliberately NOT spreading page-content.js's or llm.js's real exports
// (unlike store/read.js above) — importing either real module pulls in this
// repo's actual page-fetch/LLM SDK dependency chain, which hits an unrelated
// ESM/CJS incompatibility in a third-party transitive dependency
// (web-streams-polyfill) under --experimental-test-module-mocks. Safe:
// findExistingPageMatch's call path needs nothing else from either module.
mock.module(resolve('./page-content.js'), {
  namedExports: {
    analyzePageUrl: async (page) => {
      fetchedPages.push(page);
      return { ok: true, analysis: { bodyText: `real content about ${page}` } };
    },
    hasSufficientGroundingContent: () => true,
    // Not exercised by this test's own code path — these three exist only
    // so technical-seo-analysis.js (pulled in transitively via
    // analyst-seo-mapping.js's own import chain) still finds real, callable
    // exports to import and doesn't throw a SyntaxError on module load.
    isPrivateOrLocalHost: () => false,
    fetchResponseHeaders: async () => ({}),
    isCompressedEncoding: () => false,
  },
});
mock.module(resolve('../../llm.js'), {
  namedExports: {
    callLLM: async () => { throw new Error('these tests do not exercise LLM calls'); },
    callLLMForJson: async () => ({ covered_by: coveredByAnswer }),
  },
});
// analyst-seo-mapping.js imports generateDraft from routes/action-center.js
// and recommendationPageKey from recommendation-coordinator.js at module
// scope, both only for OTHER functions (createActionCenterRecommendationForGap
// / syncAnalystInsightsToActionCenter) this test file never exercises — but
// recommendation-coordinator.js -> command-center.js -> model-providers/index.js
// transitively pulls in the real OpenAI SDK, which is the actual source of
// the formdata-node/web-streams-polyfill load failure above, not llm.js or
// page-content.js themselves. Cut off both here, same reasoning.
mock.module(resolve('../../routes/action-center.js'), {
  namedExports: { generateDraft: async () => { throw new Error('not exercised by this test file'); } },
});
mock.module(resolve('./recommendation-coordinator.js'), {
  namedExports: { recommendationPageKey: () => { throw new Error('not exercised by this test file'); } },
});

const { findExistingPageMatch } = await import('./analyst-seo-mapping.js');

beforeEach(() => { fetchedPages = []; coveredByAnswer = null; });

describe('findExistingPageMatch — domain scoping (only the site\'s own primary domain)', () => {
  test('a page on the primary domain is a real candidate, as before', async () => {
    site = { id: 1, website_domain: 'zunkireelabs.com' };
    inventoryPages = [{ page: 'https://zunkireelabs.com/services/booking-engine' }];
    coveredByAnswer = 'https://zunkireelabs.com/services/booking-engine';

    const result = await findExistingPageMatch(1, { topic: 'booking engine' });

    assert.deepEqual(fetchedPages, ['https://zunkireelabs.com/services/booking-engine']);
    assert.equal(result, 'https://zunkireelabs.com/services/booking-engine');
  });

  test('a page on a registered additional_own_domain is NEVER fetched or considered a candidate', async () => {
    site = { id: 1, website_domain: 'zunkireelabs.com', additional_own_domains: ['edgex.zunkireelabs.com'] };
    inventoryPages = [{ page: 'https://edgex.zunkireelabs.com/booking-engine' }];

    const result = await findExistingPageMatch(1, { topic: 'booking engine' });

    assert.deepEqual(fetchedPages, [], 'edgex is a separate product — its pages must never even be fetched for a zunkireelabs.com content gap');
    assert.equal(result, null);
  });

  test('a page on a completely foreign hostname is likewise never fetched', async () => {
    site = { id: 1, website_domain: 'zunkireelabs.com' };
    inventoryPages = [{ page: 'https://supreme-court.zunkireelabs.com/booking-engine' }];

    const result = await findExistingPageMatch(1, { topic: 'booking engine' });

    assert.deepEqual(fetchedPages, []);
    assert.equal(result, null);
  });

  test('mixed inventory: only the primary-domain page is ever considered, even when a foreign page would score higher on filename overlap', async () => {
    site = { id: 1, website_domain: 'zunkireelabs.com', additional_own_domains: ['edgex.zunkireelabs.com'] };
    inventoryPages = [
      { page: 'https://edgex.zunkireelabs.com/booking-engine-crm' }, // more overlapping words
      { page: 'https://zunkireelabs.com/services/booking' },
    ];
    coveredByAnswer = 'https://zunkireelabs.com/services/booking';

    await findExistingPageMatch(1, { topic: 'booking engine crm' });

    assert.deepEqual(fetchedPages, ['https://zunkireelabs.com/services/booking']);
  });

  test('no website_domain configured passes through unfiltered — never risks excluding the site\'s own real pages on an unset config', async () => {
    site = { id: 1 };
    inventoryPages = [{ page: 'https://anything.example.com/booking-engine' }];
    coveredByAnswer = 'https://anything.example.com/booking-engine';

    const result = await findExistingPageMatch(1, { topic: 'booking engine' });

    assert.deepEqual(fetchedPages, ['https://anything.example.com/booking-engine']);
    assert.equal(result, 'https://anything.example.com/booking-engine');
  });
});
