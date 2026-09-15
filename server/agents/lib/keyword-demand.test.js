import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let keywordIdeasByLocation; // locationCode -> array of ideas, or an Error to throw
let searchVolumeByLocation; // locationCode -> array of ideas, or an Error to throw

mock.module(resolve('../../ingest/dataforseo-keywords.js'), {
  namedExports: {
    configured: () => true,
    fetchKeywordIdeas: async (seedTerms, { locationCode }) => {
      const entry = keywordIdeasByLocation[locationCode];
      if (entry instanceof Error) throw entry;
      return entry ?? [];
    },
    fetchSearchVolume: async (seedTerms, { locationCode }) => {
      const entry = searchVolumeByLocation[locationCode];
      if (entry instanceof Error) throw entry;
      return entry ?? [];
    },
  },
});
// Not exercised by fetchIdeasAcrossLocations directly, but keyword-demand.js
// imports it at module scope (for deriveSeedTermsForSite/runKeywordDemandIfDue)
// — the real SDK client's own import chain conflicts with this test runner's
// module-mock loader (a pre-existing environment issue, unrelated to this
// file), so it's stubbed here the same way competitor-intelligence.test.js
// already stubs it.
mock.module(resolve('../../llm.js'), {
  namedExports: { callLLM: async () => null, callLLMForJson: async () => null },
});

const { fetchIdeasAcrossLocations } = await import('./keyword-demand.js');

describe('fetchIdeasAcrossLocations — per-location fallback and isolation', () => {
  test('merges real ideas across every location that succeeds on keyword_ideas', async () => {
    keywordIdeasByLocation = {
      2840: [{ keyword: 'seo audit', searchVolume: 4400 }],
      2826: [{ keyword: 'seo audit', searchVolume: 200 }, { keyword: 'link building uk', searchVolume: 300 }],
    };
    searchVolumeByLocation = {};

    const result = await fetchIdeasAcrossLocations(['seo'], [
      { locationCode: 2840, languageCode: 'en' },
      { locationCode: 2826, languageCode: 'en' },
    ]);
    // Higher-volume duplicate wins across locations, plus the unique one.
    assert.deepEqual(result.map((r) => r.keyword).sort(), ['link building uk', 'seo audit']);
    assert.equal(result.find((r) => r.keyword === 'seo audit').searchVolume, 4400);
  });

  test('falls back to search_volume for a location keyword_ideas rejects (e.g. Nepal)', async () => {
    keywordIdeasByLocation = {
      2524: new Error("DataForSEO keyword_ideas task error: Invalid Field: 'location_code'."),
    };
    searchVolumeByLocation = {
      2524: [{ keyword: 'ai seo software', searchVolume: 90, difficulty: null }],
    };

    const result = await fetchIdeasAcrossLocations(['ai seo software'], [{ locationCode: 2524, languageCode: 'en' }]);
    assert.deepEqual(result, [{ keyword: 'ai seo software', searchVolume: 90, difficulty: null, locationCode: 2524 }]);
  });

  test('a location failing on both products is skipped, never aborting the other locations', async () => {
    keywordIdeasByLocation = {
      2524: new Error("Invalid Field: 'location_code'."),
      2840: [{ keyword: 'growth analytics', searchVolume: 500 }],
    };
    searchVolumeByLocation = {
      2524: new Error('DataForSEO search_volume task error: not supported'),
    };

    const result = await fetchIdeasAcrossLocations(['growth'], [
      { locationCode: 2524, languageCode: 'en' },
      { locationCode: 2840, languageCode: 'en' },
    ]);
    assert.deepEqual(result, [{ keyword: 'growth analytics', searchVolume: 500, locationCode: 2840 }]);
  });
});
