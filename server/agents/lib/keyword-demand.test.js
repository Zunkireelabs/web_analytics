import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let keywordIdeasByLocation; // locationCode -> array of ideas, or an Error to throw
let searchVolumeByLocation; // locationCode -> array of ideas, or an Error to throw
let llmJsonResult; // what callLLMForJson should resolve to for guessKeywordsForLocation tests

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
// Mirrors the real callLLMForJson's contract closely enough for these tests:
// it applies the caller's own `validate` predicate and resolves to null on
// failure, exactly like the real implementation would after a malformed
// response — guessKeywordsForLocation's `if (!parsed) return []` depends on
// that, not on this mock returning the raw value untouched.
mock.module(resolve('../../llm.js'), {
  namedExports: {
    callLLM: async () => null,
    callLLMForJson: async (system, user, { validate } = {}) => {
      if (llmJsonResult instanceof Promise) return llmJsonResult;
      if (validate && !validate(llmJsonResult)) return null;
      return llmJsonResult;
    },
  },
});

const { fetchIdeasAcrossLocations, guessKeywordsForLocation } = await import('./keyword-demand.js');

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
    assert.deepEqual(result.ideas.map((r) => r.keyword).sort(), ['link building uk', 'seo audit']);
    assert.equal(result.ideas.find((r) => r.keyword === 'seo audit').searchVolume, 4400);
    assert.deepEqual(result.failedLocations, []);
  });

  test('falls back to search_volume for a location keyword_ideas rejects (e.g. Nepal)', async () => {
    keywordIdeasByLocation = {
      2524: new Error("DataForSEO keyword_ideas task error: Invalid Field: 'location_code'."),
    };
    searchVolumeByLocation = {
      2524: [{ keyword: 'ai seo software', searchVolume: 90, difficulty: null }],
    };

    const result = await fetchIdeasAcrossLocations(['ai seo software'], [{ locationCode: 2524, languageCode: 'en' }]);
    assert.deepEqual(result.ideas, [{ keyword: 'ai seo software', searchVolume: 90, difficulty: null, locationCode: 2524 }]);
    assert.deepEqual(result.failedLocations, []);
  });

  test('a location failing on both products is skipped, never aborting the other locations, and reported as failed', async () => {
    keywordIdeasByLocation = {
      2524: new Error("Invalid Field: 'location_code'."),
      2840: [{ keyword: 'growth analytics', searchVolume: 500 }],
    };
    searchVolumeByLocation = {
      2524: new Error('DataForSEO search_volume task error: not supported'),
    };

    const location2524 = { locationCode: 2524, languageCode: 'en' };
    const result = await fetchIdeasAcrossLocations(['growth'], [
      location2524,
      { locationCode: 2840, languageCode: 'en' },
    ]);
    assert.deepEqual(result.ideas, [{ keyword: 'growth analytics', searchVolume: 500, locationCode: 2840 }]);
    assert.deepEqual(result.failedLocations, [location2524]);
  });
});

describe('guessKeywordsForLocation — last-resort LLM guess for an unsupported market', () => {
  test('returns the LLM-suggested keywords, capped at MAX_LLM_GUESS_PER_LOCATION', async () => {
    llmJsonResult = { keywords: ['seo services nepal', 'digital marketing kathmandu', 'a', 'b', 'c', 'd', 'e', 'too many'] };
    const result = await guessKeywordsForLocation(['SEO services'], { locationCode: 2524 }, 1);
    assert.equal(result.length, 5);
    assert.deepEqual(result.slice(0, 2), ['seo services nepal', 'digital marketing kathmandu']);
  });

  test('returns an empty array, never throws, when the LLM call fails', async () => {
    llmJsonResult = Promise.reject(new Error('provider down'));
    const result = await guessKeywordsForLocation(['SEO services'], { locationCode: 2524 }, 1);
    assert.deepEqual(result, []);
  });

  test('returns an empty array when the LLM response has no real keywords array', async () => {
    llmJsonResult = { notKeywords: true };
    const result = await guessKeywordsForLocation(['SEO services'], { locationCode: 2524 }, 1);
    assert.deepEqual(result, []);
  });
});
